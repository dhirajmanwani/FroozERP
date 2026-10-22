/**
 * Frooz Pack: the packing a combo goes out in (baskets, gift boxes, bottles, bowls), as stock.
 *
 * The hierarchy is Type → Design → Size, all the owner's own words ("Gift Box" › "Window Box" ›
 * "Grand · 1 kg"). Each Size is a stock item with a count on hand and a unit cost (its last
 * purchase rate). Everything here is decided without a screen.
 *
 * Three rules shaped it:
 *
 * 1. **Packing never stops a sale.** Running out is a warning (`packingShortages`), never a
 *    refusal. Nothing here is folded into `comboAvailability` / `pickFixedCombo`.
 * 2. **An unknown count is not zero.** A size whose count has not reached this computer says
 *    "unknown"; it is never shown as "out", and no shortage is claimed against it.
 * 3. **Ids are opaque strings**, compared with `inventoryIdsEqual`, never `Number()`ed. The
 *    snapshot's `id` is already the global id ("packing-size-12"); the API sends both `id` (12)
 *    and `global_id`. A size is found by either.
 *
 * Packing cost belongs to the combo's "Cost today" and suggested price (combos.js
 * `suggestComboPrice`), never to a sale's cost or profit: it was expensed when it was bought.
 */

import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

export const PACKING_SIZE_NAMES = Object.freeze(["PETITE", "CLASSIC", "GRAND", "ROYAL"]);
export const PACKING_SIZE_LABELS = Object.freeze({
  PETITE: "Petite",
  CLASSIC: "Classic",
  GRAND: "Grand",
  ROYAL: "Royal",
});

/** At or below this many on hand a size is "low" (and at or below 0, "out"). */
export const PACKING_LOW_STOCK_AT = 5;

export const PACKING_PAYMENT_MODES = Object.freeze(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE"]);

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const upper = (value) => text(value).toUpperCase();

const finiteOrNull = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isActive = (value) => value !== false && value !== 0 && value !== "false" && value !== "0";

const toPaise = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.sign(number) * Math.round(Math.abs(number) * 100 + 1e-7);
};

const toThousandths = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.sign(number) * Math.round(Math.abs(number) * 1000 + 1e-7);
};

const round3 = (value) => Math.round((value + Number.EPSILON) * 1000) / 1000;
const round2 = (value) => Math.round((value + Number.EPSILON) * 100) / 100;

const hasAtMostDecimals = (value, places) => {
  const raw = text(value);
  if (raw === "") return false;
  if (/e/i.test(raw)) return false;
  const [, fraction = ""] = raw.split(".");
  return fraction.length <= places;
};

const formatCount = (value) => (Number.isFinite(value)
  ? value.toLocaleString("en-IN", { maximumFractionDigits: 3 })
  : "unknown");

// ---------------------------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------------------------

/** A node's id: the global id when it has one (what combos and sale rows name), else its own id. */
const nodeId = (row) => text(row?.global_id) || text(row?.id);

/** Every id a node answers to. */
const nodeIds = (node) => [node?.id, node?.global_id, node?.server_id].map(canonicalInventoryId).filter(Boolean);

const nodeMatches = (node, id) => {
  const wanted = canonicalInventoryId(id);
  return wanted !== "" && nodeIds(node).some((key) => inventoryIdsEqual(key, wanted));
};

const byOrder = (left, right) => (
  (left.sort_order - right.sort_order) || left.name.localeCompare(right.name, "en-IN", { sensitivity: "base" })
);

const sizeRank = (name) => {
  const index = PACKING_SIZE_NAMES.indexOf(upper(name));
  return index === -1 ? PACKING_SIZE_NAMES.length : index;
};

const bySizeOrder = (left, right) => (
  (left.sort_order - right.sort_order)
  || (sizeRank(left.size_name) - sizeRank(right.size_name))
  || left.capacity.localeCompare(right.capacity, "en-IN", { numeric: true, sensitivity: "base" })
);

/** Reads a nested list; `undefined`/`null` is an empty list, anything else not an array is a violation. */
const nestedList = (value, problems, what) => {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    problems.push(what);
    return [];
  }
  return value.filter((row) => row && typeof row === "object");
};

const normaliseSize = (row, index) => ({
  id: nodeId(row),
  global_id: text(row?.global_id) || nodeId(row),
  server_id: text(row?.id),
  size_name: upper(row?.size_name),
  capacity: text(row?.capacity),
  // NUMERIC arrives as a string from Postgres; unknown stays null, never 0.
  unit_cost: finiteOrNull(row?.unit_cost),
  active: isActive(row?.active),
  sort_order: finiteOrNull(row?.sort_order) ?? index,
  qty_on_hand: finiteOrNull(row?.qty_on_hand),
  cloud_qty_on_hand: finiteOrNull(row?.cloud_qty_on_hand),
  pending_usage: finiteOrNull(row?.pending_usage),
});

const normaliseDesign = (row, index, problems) => ({
  id: nodeId(row),
  global_id: text(row?.global_id) || nodeId(row),
  server_id: text(row?.id),
  name: text(row?.name),
  active: isActive(row?.active),
  sort_order: finiteOrNull(row?.sort_order) ?? index,
  sizes: nestedList(row?.sizes, problems, `sizes of design "${text(row?.name) || nodeId(row)}"`)
    .map(normaliseSize)
    .sort(bySizeOrder),
});

const normaliseType = (row, index, problems) => ({
  id: nodeId(row),
  global_id: text(row?.global_id) || nodeId(row),
  server_id: text(row?.id),
  name: text(row?.name),
  active: isActive(row?.active),
  sort_order: finiteOrNull(row?.sort_order) ?? index,
  designs: nestedList(row?.designs, problems, `designs of type "${text(row?.name) || nodeId(row)}"`)
    .map((design, designIndex) => normaliseDesign(design, designIndex, problems))
    .sort(byOrder),
});

export const PACKING_MISSING_MESSAGE = "The packing list has not reached this computer yet. It arrives with the next sync once the Owner or an Admin sets packing up in Frooz Pack.";

/**
 * The packing catalogue, from the snapshot's `packing` ({ status, types }) or the
 * `GET /api/v3/packing` body ({ types }), as a named state.
 *
 * `missing` is not `ready` with nothing in it: a counter that has never been told what packing
 * exists must not say "no packing". Anything unreadable is `invalid`, with a message, never zero.
 */
export const readPackingCatalogue = (source) => {
  if (source === undefined || source === null) return { status: "missing", types: [], message: PACKING_MISSING_MESSAGE };
  if (typeof source !== "object") {
    return { status: "invalid", types: [], message: "The packing list could not be read: it is not a list." };
  }
  const list = Array.isArray(source) ? source : source.types;
  const status = Array.isArray(source) ? "" : text(source.status).toLowerCase();
  if (status === "missing") return { status: "missing", types: [], message: PACKING_MISSING_MESSAGE };
  if (status !== "" && status !== "ready") {
    return { status: "invalid", types: [], message: `The packing list could not be read: its status is "${text(source.status)}".` };
  }
  if (list === undefined || list === null) {
    return status === "ready"
      ? { status: "invalid", types: [], message: "The packing list could not be read: it says ready but has no types." }
      : { status: "missing", types: [], message: PACKING_MISSING_MESSAGE };
  }
  if (!Array.isArray(list)) {
    return { status: "invalid", types: [], message: "The packing list could not be read: its types are not a list." };
  }
  const problems = [];
  const types = list
    .filter((row) => row && typeof row === "object")
    .map((row, index) => normaliseType(row, index, problems))
    .sort(byOrder);
  if (problems.length > 0) {
    return { status: "invalid", types: [], message: `The packing list could not be read: the ${problems[0]} are not a list.` };
  }
  return { status: "ready", types, message: "" };
};

const catalogueTypes = (catalogue) => {
  if (Array.isArray(catalogue)) return catalogue;
  return Array.isArray(catalogue?.types) ? catalogue.types : [];
};

/** "Grand · 1 kg"; with no capacity, "Grand". An unknown size name is shown as given. */
export const packingSizeLabel = (size) => {
  const name = upper(size?.size_name);
  const label = PACKING_SIZE_LABELS[name] || text(size?.size_name);
  const capacity = text(size?.capacity);
  if (label === "") return capacity;
  return capacity ? `${label} · ${capacity}` : label;
};

/** "Gift Box › Window Box › Grand · 1 kg". Parts that are not known are left out. */
export const packingPathLabel = ({ type_name, design_name, size_name, capacity } = {}) => [
  text(type_name),
  text(design_name),
  packingSizeLabel({ size_name, capacity }),
].filter(Boolean).join(" › ");

/** The size `sizeId` names (by either id), with its design and type, or null. Inactive ones too. */
export const findPackingSize = (catalogue, sizeId) => {
  if (canonicalInventoryId(sizeId) === "") return null;
  for (const type of catalogueTypes(catalogue)) {
    for (const design of Array.isArray(type?.designs) ? type.designs : []) {
      for (const size of Array.isArray(design?.sizes) ? design.sizes : []) {
        if (nodeMatches(size, sizeId)) return { type, design, size };
      }
    }
  }
  return null;
};

// ---------------------------------------------------------------------------------------------
// The drill-down picker: types → designs → sizes
// ---------------------------------------------------------------------------------------------

/** "ok", "low", "out" or "unknown" for one count. Unknown is never "out". */
export const packingStockState = (qtyOnHand) => {
  const qty = finiteOrNull(qtyOnHand);
  if (qty === null) return "unknown";
  if (qty <= 0) return "out";
  if (qty <= PACKING_LOW_STOCK_AT) return "low";
  return "ok";
};

const activeSizes = (design) => (Array.isArray(design?.sizes) ? design.sizes : []).filter((size) => size && size.active !== false);
const visibleDesigns = (type) => (Array.isArray(type?.designs) ? type.designs : [])
  .filter((design) => design && design.active !== false && activeSizes(design).length > 0);
const visibleTypes = (catalogue) => catalogueTypes(catalogue)
  .filter((type) => type && type.active !== false && visibleDesigns(type).length > 0);

/**
 * A group's state from its sizes: every size out → "out"; any out or low → "low" (something
 * under it needs buying); otherwise any unknown → "unknown"; else "ok".
 */
const groupStockState = (sizes) => {
  const states = sizes.map((size) => packingStockState(size.qty_on_hand));
  if (states.length > 0 && states.every((state) => state === "out")) return "out";
  if (states.some((state) => state === "out" || state === "low")) return "low";
  if (states.some((state) => state === "unknown")) return "unknown";
  return "ok";
};

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

export const createPackingDrill = () => ({ level: "types", typeId: null, designId: null });

const drillState = (state) => {
  const level = ["types", "designs", "sizes"].includes(state?.level) ? state.level : "types";
  const typeId = canonicalInventoryId(state?.typeId) || null;
  const designId = canonicalInventoryId(state?.designId) || null;
  if (level === "types" || !typeId) return createPackingDrill();
  if (level === "designs" || !designId) return { level: "designs", typeId, designId: null };
  return { level: "sizes", typeId, designId };
};

/**
 * Go one level down into `id`. At the sizes level there is nowhere further (picking a size is the
 * caller's), so the state is unchanged. With `catalogue`, an id that is not a visible row of the
 * current level leaves the state unchanged too; without one, only an empty id does.
 */
export const enterPackingDrill = (state, id, catalogue) => {
  const current = drillState(state);
  const wanted = canonicalInventoryId(id);
  if (wanted === "" || current.level === "sizes") return current;
  if (current.level === "types") {
    if (catalogue !== undefined && catalogue !== null) {
      const type = visibleTypes(catalogue).find((entry) => nodeMatches(entry, wanted));
      if (!type) return current;
      return { level: "designs", typeId: type.id, designId: null };
    }
    return { level: "designs", typeId: wanted, designId: null };
  }
  if (catalogue !== undefined && catalogue !== null) {
    const type = visibleTypes(catalogue).find((entry) => nodeMatches(entry, current.typeId));
    const design = type ? visibleDesigns(type).find((entry) => nodeMatches(entry, wanted)) : null;
    if (!design) return current;
    return { level: "sizes", typeId: current.typeId, designId: design.id };
  }
  return { level: "sizes", typeId: current.typeId, designId: wanted };
};

/** One level up: sizes → designs, designs → types; types stays. */
export const backPackingDrill = (state) => {
  const current = drillState(state);
  if (current.level === "sizes") return { level: "designs", typeId: current.typeId, designId: null };
  return createPackingDrill();
};

/**
 * What an empty picker says. "Nothing set up" was wrong once types exist: only a size can be
 * picked, so a type with no design or no size under it is invisible here. Name those types and
 * say what is missing, so the owner knows where to go instead of re-creating the type.
 */
/** Active types with no active size under any active design, by name -- invisible to a picker. */
export const packingTypesWithoutSize = (catalogue) => (Array.isArray(catalogue) ? catalogue : Array.isArray(catalogue?.types) ? catalogue.types : [])
  .filter((type) => type && type.active !== false)
  .filter((type) => !(Array.isArray(type.designs) ? type.designs : []).some((design) => design && design.active !== false && activeSizes(design).length > 0))
  .map((type) => text(type.name) || "A packing type");

export const packingEmptyPickerMessage = (catalogue) => {
  const types = (Array.isArray(catalogue) ? catalogue : Array.isArray(catalogue?.types) ? catalogue.types : [])
    .filter((type) => type && type.active !== false);
  if (types.length === 0) return "No packing set up yet. The Owner or an Admin adds it in Frooz Pack.";
  const unfinished = types
    .filter((type) => !(Array.isArray(type.designs) ? type.designs : []).some((design) => design && design.active !== false && activeSizes(design).length > 0))
    .map((type) => text(type.name) || "A packing type");
  if (unfinished.length === 0) return "No packing set up yet. The Owner or an Admin adds it in Frooz Pack.";
  return `${unfinished.join(", ")} ${unfinished.length === 1 ? "has" : "have"} no size yet. In Frooz Pack, open ${unfinished.length === 1 ? "it" : "each one"} with →, add a Design, then add a Size inside it.`;
};

const ROOT_CRUMB_LABEL = "Packing";

/**
 * What the picker shows for `state`. Only active entries, and a type or design with no active
 * size is hidden. A state that points at something no longer shown falls back up a level, so a
 * catalogue refreshed under an open picker never shows an empty screen. Leaf rows carry what a
 * packing row needs (`packing_size_id`, names, `unit_cost`).
 */
export const packingDrillView = (catalogue, state) => {
  const status = Array.isArray(catalogue) ? "ready" : (text(catalogue?.status) || "ready");
  const message = Array.isArray(catalogue) ? "" : text(catalogue?.message);
  const current = drillState(state);
  const types = visibleTypes(catalogue);
  const type = current.typeId ? types.find((entry) => nodeMatches(entry, current.typeId)) : null;
  const design = type && current.designId ? visibleDesigns(type).find((entry) => nodeMatches(entry, current.designId)) : null;
  const rootCrumb = { level: "types", id: null, label: ROOT_CRUMB_LABEL };

  if (current.level === "sizes" && type && design) {
    return {
      status,
      message,
      level: "sizes",
      title: design.name,
      crumbs: [rootCrumb, { level: "designs", id: type.id, label: type.name }, { level: "sizes", id: design.id, label: design.name }],
      rows: activeSizes(design).map((size) => ({
        id: size.id,
        label: packingSizeLabel(size),
        sublabel: Number.isFinite(size.unit_cost) && size.unit_cost > 0 ? `₹${size.unit_cost.toFixed(2)} each` : "Cost not set",
        qty_on_hand: Number.isFinite(size.qty_on_hand) ? size.qty_on_hand : null,
        stockState: packingStockState(size.qty_on_hand),
        leaf: true,
        packing_size_id: size.id,
        type_name: type.name,
        design_name: design.name,
        size_name: size.size_name,
        capacity: size.capacity,
        unit_cost: Number.isFinite(size.unit_cost) ? size.unit_cost : null,
      })),
    };
  }
  if ((current.level === "designs" || current.level === "sizes") && type) {
    return {
      status,
      message,
      level: "designs",
      title: type.name,
      crumbs: [rootCrumb, { level: "designs", id: type.id, label: type.name }],
      rows: visibleDesigns(type).map((entry) => {
        const sizes = activeSizes(entry);
        return {
          id: entry.id,
          label: entry.name,
          sublabel: plural(sizes.length, "size", "sizes"),
          qty_on_hand: null,
          stockState: groupStockState(sizes),
          leaf: false,
        };
      }),
    };
  }
  return {
    status,
    message,
    level: "types",
    title: "Choose packing",
    crumbs: [rootCrumb],
    rows: types.map((entry) => {
      const designs = visibleDesigns(entry);
      return {
        id: entry.id,
        label: entry.name,
        sublabel: plural(designs.length, "design", "designs"),
        qty_on_hand: null,
        stockState: groupStockState(designs.flatMap(activeSizes)),
        leaf: false,
      };
    }),
  };
};

/**
 * The Frooz Pack screen's own view of the tree, for the Owner or Admin who keeps it. Unlike the
 * picker it shows everything: switched-off entries (marked, so they can be switched back on) and
 * a type or design with no sizes yet (otherwise a type just added would vanish before it could be
 * given a design). Takes the same state as the picker (`createPackingDrill`, `enterPackingDrill`
 * without a catalogue, `backPackingDrill`); a state that points at something not there falls back
 * up a level. Rows carry the node itself (`node`) for the edit form.
 */
export const packingManageView = (catalogue, state) => {
  const current = drillState(state);
  const types = catalogueTypes(catalogue).filter((entry) => entry && typeof entry === "object");
  const type = current.typeId ? types.find((entry) => nodeMatches(entry, current.typeId)) || null : null;
  const designs = type && Array.isArray(type.designs) ? type.designs.filter((entry) => entry && typeof entry === "object") : [];
  const design = type && current.designId ? designs.find((entry) => nodeMatches(entry, current.designId)) || null : null;
  const rootCrumb = { level: "types", id: null, label: ROOT_CRUMB_LABEL };
  const groupState = (sizes) => (sizes.length === 0 ? null : groupStockState(sizes));

  if (current.level === "sizes" && type && design) {
    const sizes = (Array.isArray(design.sizes) ? design.sizes : []).filter((entry) => entry && typeof entry === "object");
    return {
      level: "sizes",
      title: design.name,
      type,
      design,
      crumbs: [rootCrumb, { level: "designs", id: type.id, label: type.name }, { level: "sizes", id: design.id, label: design.name }],
      rows: sizes.map((size) => ({
        id: size.id,
        label: packingSizeLabel(size),
        sublabel: knownUnitCost(size.unit_cost) === null ? "Cost not set" : `₹${size.unit_cost.toFixed(2)} each`,
        active: size.active !== false,
        qty_on_hand: Number.isFinite(size.qty_on_hand) ? size.qty_on_hand : null,
        stockState: packingStockState(size.qty_on_hand),
        unit_cost: Number.isFinite(size.unit_cost) ? size.unit_cost : null,
        leaf: true,
        node: size,
      })),
    };
  }
  if ((current.level === "designs" || current.level === "sizes") && type) {
    return {
      level: "designs",
      title: type.name,
      type,
      design: null,
      crumbs: [rootCrumb, { level: "designs", id: type.id, label: type.name }],
      rows: designs.map((entry) => {
        const sizes = Array.isArray(entry.sizes) ? entry.sizes : [];
        return {
          id: entry.id,
          label: entry.name,
          sublabel: sizes.length === 0 ? "No sizes yet" : plural(sizes.length, "size", "sizes"),
          active: entry.active !== false,
          qty_on_hand: null,
          stockState: groupState(activeSizes(entry)),
          unit_cost: null,
          leaf: false,
          node: entry,
        };
      }),
    };
  }
  return {
    level: "types",
    title: "Packing",
    type: null,
    design: null,
    crumbs: [rootCrumb],
    rows: types.map((entry) => {
      const children = Array.isArray(entry.designs) ? entry.designs : [];
      return {
        id: entry.id,
        label: entry.name,
        sublabel: children.length === 0 ? "No designs yet" : plural(children.length, "design", "designs"),
        active: entry.active !== false,
        qty_on_hand: null,
        stockState: groupState(children.filter((design) => design && design.active !== false).flatMap(activeSizes)),
        unit_cost: null,
        leaf: false,
        node: entry,
      };
    }),
  };
};

/** How a stock movement reads on the Frooz Pack screen. */
export const PACKING_MOVEMENT_LABELS = Object.freeze({
  PURCHASE: "Bought",
  SALE: "Sold with a combo",
  SALE_CANCEL: "Bill cancelled, put back",
  ADJUST: "Count corrected",
});

// ---------------------------------------------------------------------------------------------
// Cost
// ---------------------------------------------------------------------------------------------

const rowSizeId = (row) => text(row?.packing_size_id) || text(row?.size_id) || text(row?.size_global_id);

/** A packing unit cost is known only when it is above ₹0: an unset cost is stored as 0. */
const knownUnitCost = (value) => {
  const cost = finiteOrNull(value);
  return cost !== null && cost > 0 ? cost : null;
};

/**
 * What `packingRows` cost: Σ quantity × unit cost, rounded once to the paisa. A row's own
 * `unit_cost` wins; else the catalogue's for its size. A row with no usable quantity or no known
 * cost makes the whole thing unknown (`cost: null`): a part-sum is never shown as the whole.
 * No rows cost ₹0, known.
 */
export const packingCostOf = (packingRows, catalogue) => {
  let total = 0; // paise × thousandths
  for (const row of Array.isArray(packingRows) ? packingRows : []) {
    const quantity = toThousandths(row?.quantity);
    if (quantity === null || quantity <= 0) return { known: false, cost: null };
    let unitCost = knownUnitCost(row?.unit_cost);
    if (unitCost === null && catalogue !== undefined && catalogue !== null) {
      unitCost = knownUnitCost(findPackingSize(catalogue, rowSizeId(row))?.size?.unit_cost);
    }
    if (unitCost === null) return { known: false, cost: null };
    total += quantity * toPaise(unitCost);
  }
  const paise = Math.floor((total * 2 + 1000) / 2000);
  return { known: true, cost: paise / 100 };
};

// ---------------------------------------------------------------------------------------------
// The bill: what packing a sale used
// ---------------------------------------------------------------------------------------------

const comboKey = (line) => canonicalInventoryId(line?.combo_line_key);

const findCombo = (combos, comboId) => (Array.isArray(combos) ? combos : [])
  .find((combo) => [combo?.global_id, combo?.id].some((id) => inventoryIdsEqual(id, comboId))) || null;

const customRowsFor = (customPacking, key, rawKey) => {
  if (!customPacking || typeof customPacking !== "object") return [];
  const rows = customPacking[key] ?? customPacking[rawKey];
  return Array.isArray(rows) ? rows : [];
};

/**
 * The bill's `packing_usage`: one row per (combo on the bill, packing size).
 *
 * FIXED combos take their packing from the combo itself (`combos`, matched by global id or id),
 * times how many were sold. CUSTOM combos take what the cashier picked (`customPacking`, keyed by
 * `combo_line_key`) times the combo's quantity. A combo's lines are counted once, however many
 * products it has. A combo with no packing has no rows. Rows that cannot be read are left out and
 * named in `warnings`: packing never stops the bill.
 */
export const buildSalePackingUsage = ({ lines = [], combos = [], customPacking = {} } = {}) => {
  const groups = new Map();
  for (const line of Array.isArray(lines) ? lines : []) {
    const key = comboKey(line);
    if (key === "" || groups.has(key)) continue;
    groups.set(key, { key, rawKey: line.combo_line_key, line });
  }
  const usage = [];
  const warnings = [];
  for (const { key, rawKey, line } of groups.values()) {
    const comboName = text(line.combo_name) || "A combo";
    const comboType = upper(line.combo_type);
    const comboId = text(line.combo_id);
    const comboQty = finiteOrNull(line.combo_qty);
    if (comboQty === null || comboQty < 1 || !Number.isInteger(comboQty)) {
      return {
        ok: false,
        usage: [],
        warnings,
        message: `${comboName}: how many were sold could not be read, so its packing could not be counted.`,
      };
    }
    let rows;
    if (comboType === "FIXED") {
      const combo = findCombo(combos, comboId);
      if (!combo) {
        warnings.push(`${comboName}: the combo is not on this computer, so its packing was not counted.`);
        continue;
      }
      rows = Array.isArray(combo.packing) ? combo.packing : [];
    } else if (comboType === "CUSTOM") {
      rows = customRowsFor(customPacking, key, rawKey);
    } else {
      warnings.push(`${comboName}: not a fixed or customer's-choice combo, so its packing was not counted.`);
      continue;
    }
    const bySize = new Map();
    for (const row of rows) {
      const sizeId = canonicalInventoryId(rowSizeId(row));
      const perCombo = toThousandths(row?.quantity);
      if (sizeId === "" || perCombo === null || perCombo <= 0) {
        warnings.push(`${comboName}: a packing row could not be read and was not counted.`);
        continue;
      }
      const existing = [...bySize.keys()].find((id) => inventoryIdsEqual(id, sizeId));
      if (existing) {
        bySize.get(existing).thousandths += perCombo * comboQty;
        continue;
      }
      bySize.set(sizeId, {
        thousandths: perCombo * comboQty,
        row: {
          combo_line_key: key,
          combo_id: comboId,
          source: comboType,
          packing_size_id: sizeId,
          type_name: text(row?.type_name),
          design_name: text(row?.design_name),
          size_name: upper(row?.size_name),
          capacity: text(row?.capacity),
          quantity: 0,
          unit_cost: finiteOrNull(row?.unit_cost) === null ? null : round2(finiteOrNull(row.unit_cost)),
        },
      });
    }
    for (const { thousandths, row } of bySize.values()) {
      usage.push({ ...row, quantity: round3(thousandths / 1000) });
    }
  }
  return { ok: true, usage, warnings, message: warnings[0] || "" };
};

/**
 * Sizes the bill uses more of than this branch has, totalled across the bill. Warning only. A size
 * that is not in the catalogue, or whose count is not known, claims no shortage: "unknown" is
 * not "out".
 */
export const packingShortages = ({ usage = [], catalogue = null } = {}) => {
  const needs = [];
  for (const row of Array.isArray(usage) ? usage : []) {
    const sizeId = canonicalInventoryId(rowSizeId(row));
    const quantity = toThousandths(row?.quantity);
    if (sizeId === "" || quantity === null || quantity <= 0) continue;
    const found = findPackingSize(catalogue, sizeId);
    const canonical = found ? found.size.id : sizeId;
    const existing = needs.find((need) => inventoryIdsEqual(need.sizeId, canonical));
    if (existing) existing.thousandths += quantity;
    else needs.push({ sizeId: canonical, thousandths: quantity, found, row });
  }
  const shortages = [];
  for (const need of needs) {
    if (!need.found) continue;
    const onHand = finiteOrNull(need.found.size.qty_on_hand);
    if (onHand === null) continue;
    if (need.thousandths <= toThousandths(onHand)) continue;
    const { type, design, size } = need.found;
    shortages.push({
      key: `packing-short:${canonicalInventoryId(size.id)}`,
      label: packingPathLabel({ type_name: type.name, design_name: design.name, size_name: size.size_name, capacity: size.capacity }),
      needed: round3(need.thousandths / 1000),
      onHand: round3(onHand),
    });
  }
  return shortages;
};

/** The bell's rows for `packingShortages`: a warning per size; the bill went through regardless. */
export const packingShortageNotifications = (shortages) => (Array.isArray(shortages) ? shortages : []).map((shortage) => ({
  severity: "warning",
  title: `Packing running short: ${shortage.label}`,
  message: `${formatCount(shortage.needed)} needed, ${formatCount(shortage.onHand)} on hand. The bill still goes through; buy more in Frooz Pack, or correct the count with an adjustment.`,
  source: "Frooz Pack",
  dedupeKey: shortage.key,
}));

// ---------------------------------------------------------------------------------------------
// Writes: payloads checked before they are sent
// ---------------------------------------------------------------------------------------------

const refuse = (message) => ({ ok: false, payload: null, message });

const isRealDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map((part) => Number.parseInt(part, 10));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};

const lineSizeId = (line) => text(line?.size_id) || text(line?.packing_size_id);

/**
 * What `POST /api/v3/packing/purchases` takes, or the first problem in words. A line left wholly
 * blank (no size, quantity or rate) is dropped, so the form's spare row is not an error. A blank
 * date is left to the server (today). `total` is Σ quantity × rate for the form to show; the
 * server works the amount out itself.
 */
export const buildPackingPurchasePayload = (draft = {}) => {
  const paymentMode = upper(draft?.payment_mode);
  if (!PACKING_PAYMENT_MODES.includes(paymentMode)) return refuse("Choose how it was paid: Cash, UPI, Bank transfer or Cheque.");
  const purchaseDate = text(draft?.purchase_date);
  if (purchaseDate !== "" && !isRealDate(purchaseDate)) return refuse("Enter the purchase date as a real date (YYYY-MM-DD).");
  const supplier = text(draft?.supplier_name);
  if (supplier.length > 160) return refuse("Keep the supplier name to 160 letters or fewer.");
  const reference = text(draft?.reference_number);
  if (reference.length > 80) return refuse("Keep the bill or reference number to 80 letters or fewer.");
  const rows = (Array.isArray(draft?.lines) ? draft.lines : [])
    .filter((line) => !(lineSizeId(line) === "" && text(line?.quantity) === "" && text(line?.rate) === ""));
  if (rows.length === 0) return refuse("Add at least one packing line.");
  const lines = [];
  const seen = [];
  let totalPaise = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const line = rows[index];
    const row = index + 1;
    const sizeId = canonicalInventoryId(lineSizeId(line));
    if (sizeId === "") return refuse(`Line ${row}: choose a packing size.`);
    if (seen.some((id) => inventoryIdsEqual(id, sizeId))) return refuse(`Line ${row}: this size is listed twice. Put the whole quantity on one line.`);
    seen.push(sizeId);
    const quantity = finiteOrNull(line?.quantity);
    if (quantity === null || quantity <= 0 || !hasAtMostDecimals(line.quantity, 3)) {
      return refuse(`Line ${row}: enter a quantity above 0, with at most 3 decimals.`);
    }
    const rate = finiteOrNull(line?.rate);
    if (rate === null || rate < 0 || !hasAtMostDecimals(line.rate, 2)) {
      return refuse(`Line ${row}: enter a rate of ₹0 or more, with at most 2 decimals.`);
    }
    totalPaise += Math.floor((toThousandths(quantity) * toPaise(rate) * 2 + 1000) / 2000);
    lines.push({ size_id: sizeId, quantity, rate });
  }
  const payload = {
    supplier_name: supplier,
    payment_mode: paymentMode,
    reference_number: reference,
    remarks: text(draft?.remarks),
    lines,
  };
  if (purchaseDate !== "") payload.purchase_date = purchaseDate;
  return { ok: true, payload, message: "", total: totalPaise / 100 };
};

/**
 * What `POST /api/v3/packing/adjustments` takes: a signed, non-zero quantity and a reason. The
 * owner's way to correct a count (there is no purchase cancel in v1).
 */
export const buildPackingAdjustmentPayload = (draft = {}) => {
  const sizeId = canonicalInventoryId(lineSizeId(draft));
  if (sizeId === "") return refuse("Choose the packing size to correct.");
  const quantity = finiteOrNull(draft?.quantity);
  const raw = text(draft?.quantity).replace(/^[+-]/, "");
  if (quantity === null || quantity === 0 || !hasAtMostDecimals(raw, 3)) {
    return refuse("Enter how many to add (or, with a minus, to take off), not 0, with at most 3 decimals.");
  }
  const reason = text(draft?.reason);
  if (reason === "") return refuse("Say why the count is being corrected.");
  return { ok: true, payload: { size_id: sizeId, quantity, reason }, message: "" };
};

const sortOrderOf = (value) => {
  if (text(value) === "") return 0;
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) ? number : null;
};

const NODE_WORDS = Object.freeze({ type: "packing type", design: "design", size: "size" });

/**
 * A type, design or size form, checked as the server checks it, and the body POST/PUT takes.
 * `kind` is "type", "design" or "size".
 */
export const validatePackingNode = (kind, draft = {}) => {
  const which = text(kind).toLowerCase();
  if (!Object.hasOwn(NODE_WORDS, which)) return refuse("Choose whether this is a packing type, design or size.");
  const sortOrder = sortOrderOf(draft?.sort_order);
  if (sortOrder === null) return refuse("The order must be a whole number.");
  const active = isActive(draft?.active);
  if (which === "type" || which === "design") {
    const name = text(draft?.name);
    if (name === "") return refuse(`Give the ${NODE_WORDS[which]} a name.`);
    if (name.length > 80) return refuse(`Keep the ${NODE_WORDS[which]} name to 80 letters or fewer.`);
    if (which === "type") return { ok: true, payload: { name, active, sort_order: sortOrder }, message: "" };
    const typeId = canonicalInventoryId(draft?.type_id);
    if (typeId === "") return refuse("Choose which packing type this design belongs to.");
    return { ok: true, payload: { type_id: typeId, name, active, sort_order: sortOrder }, message: "" };
  }
  const designId = canonicalInventoryId(draft?.design_id);
  if (designId === "") return refuse("Choose which design this size belongs to.");
  const sizeName = upper(draft?.size_name);
  if (!PACKING_SIZE_NAMES.includes(sizeName)) return refuse("Choose a size: Petite, Classic, Grand or Royal.");
  const capacity = text(draft?.capacity);
  if (capacity.length > 40) return refuse("Keep the capacity to 40 letters or fewer (for example 1 kg or 300 ml).");
  const payload = { design_id: designId, size_name: sizeName, capacity, active, sort_order: sortOrder };
  if (text(draft?.unit_cost) !== "") {
    const unitCost = finiteOrNull(draft.unit_cost);
    if (unitCost === null || unitCost < 0 || !hasAtMostDecimals(draft.unit_cost, 2)) {
      return refuse("The unit cost must be ₹0 or more, with at most 2 decimals.");
    }
    payload.unit_cost = unitCost;
  }
  return { ok: true, payload, message: "" };
};

// ---------------------------------------------------------------------------------------------
// Where Frooz Pack can work
// ---------------------------------------------------------------------------------------------

/**
 * Why the Frooz Pack screen cannot load or save here, or null. Packing is kept on the server, like
 * combos (`resolveComboAvailability`): Local Only, no cloud and offline each say so instead of
 * trying. Local Only is checked first and never reaches for the network. POS keeps selling, and
 * keeps counting the packing it already knows about.
 *
 * `cloudConfigured` is optional: pass `false` on a desktop with no cloud server set up.
 */
export const resolvePackAvailability = ({ connectivityMode, online, isTauri = false, cloudConfigured } = {}) => {
  const mode = upper(connectivityMode);
  if (mode === "LOCAL_ONLY" || mode === "SIMULATE_OFFLINE") {
    return "This computer is in Local Only mode. Packing is kept on the server, so it cannot be loaded or changed here until Local Only is turned off. POS keeps selling, and keeps counting the packing it already knows.";
  }
  if (isTauri === true && cloudConfigured === false) {
    return "This computer is not connected to a cloud server. Packing is kept on the server, so it cannot be loaded or changed here. POS keeps selling, and keeps counting the packing it already knows.";
  }
  if (online === false) {
    return "This computer is offline. Packing is kept on the server, so it cannot be loaded or changed until the connection is back. POS keeps selling, and keeps counting the packing it already knows.";
  }
  return null;
};
