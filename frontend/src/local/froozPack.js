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

// Only the owner's list (GET /api/v3/packing) says whether something has been used; the counter's
// snapshot does not. Unknown stays null, and null is never "unused".
const readInUse = (value) => (value === true ? true : value === false ? false : null);

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
  in_use: readInUse(row?.in_use),
});

const normaliseDesign = (row, index, problems) => ({
  id: nodeId(row),
  global_id: text(row?.global_id) || nodeId(row),
  server_id: text(row?.id),
  name: text(row?.name),
  active: isActive(row?.active),
  sort_order: finiteOrNull(row?.sort_order) ?? index,
  in_use: readInUse(row?.in_use),
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
  in_use: readInUse(row?.in_use),
  designs: nestedList(row?.designs, problems, `designs of type "${text(row?.name) || nodeId(row)}"`)
    .map((design, designIndex) => normaliseDesign(design, designIndex, problems))
    .sort(byOrder),
});

/**
 * Whether the owner may delete this type, design or size: only when the server said nothing has
 * used it (bought, billed, counted or put in a combo). The server checks again and refuses (409).
 */
export const packingDeletable = (node) => node?.in_use === false;

export const PACKING_IN_USE_NOTE = 'Already used (bought, billed, counted or in a combo), so it cannot be deleted. Untick "In use" to hide it from billing and combos; its old bills and expenses stay as they are.';

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
  return `${unfinished.join(", ")} ${unfinished.length === 1 ? "has" : "have"} no size yet. In Frooz Pack, press New packing, choose ${unfinished.length === 1 ? "it" : "each one"}, name a design and tick its sizes.`;
};

const ROOT_CRUMB_LABEL = "Packing";

/**
 * What a size row says under its name wherever packing is picked: "On hand 12 · last ₹4.50".
 * A count that has not reached this computer says "Count not known", and a size never bought
 * (cost unset, stored as 0) says "no rate yet" -- an unknown is never shown as 0.
 */
export const packingLeafSublabel = (size) => {
  const qty = finiteOrNull(size?.qty_on_hand);
  const cost = knownUnitCost(size?.unit_cost);
  const count = qty === null ? "Count not known" : `On hand ${formatCount(qty)}`;
  return `${count} · ${cost === null ? "no rate yet" : `last ₹${cost.toFixed(2)}`}`;
};

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
        sublabel: packingLeafSublabel(size),
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
  const clientRef = text(draft?.client_ref);
  if (clientRef !== "" && !PACKING_CLIENT_REF_PATTERN.test(clientRef)) {
    return refuse("This purchase form has a reference the server cannot read. Cancel it and start the purchase again.");
  }
  // Each line keeps its place in the table, so "Line 3" is the third row on screen even when the
  // second is the blank spare one that is left out.
  const rows = (Array.isArray(draft?.lines) ? draft.lines : [])
    .map((line, index) => ({ line, position: index + 1 }))
    .filter(({ line }) => !(lineSizeId(line) === "" && text(line?.quantity) === "" && text(line?.rate) === ""));
  if (rows.length === 0) return refuse("Add at least one packing line.");
  const lines = [];
  const seen = [];
  let totalPaise = 0;
  for (let index = 0; index < rows.length; index += 1) {
    const { line, position: row } = rows[index];
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
  if (clientRef !== "") payload.client_ref = clientRef;
  return { ok: true, payload, message: "", total: totalPaise / 100 };
};

// What the server reads as a purchase form's `client_ref` (backend/froozPack.js CLIENT_REF_PATTERN).
const PACKING_CLIENT_REF_PATTERN = /^[A-Za-z0-9._:-]{1,80}$/;

/**
 * A packing purchase form's idempotency key, made once when the form opens and sent with every
 * Save of that form. A save whose answer was lost (a timeout after the server committed) is then
 * answered with the first purchase when Save is pressed again, instead of booking the boxes and the
 * expense twice. A new form, after a save went through, gets a new key.
 */
export const newPackingPurchaseClientRef = ({ randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto), now = Date.now, random = Math.random } = {}) => {
  // randomUUID exists only in a secure context; a browser on plain http on the shop's network has
  // none, so the fallback is time plus two random draws (one form at a time per person).
  const unique = typeof randomUUID === "function"
    ? randomUUID()
    : `${now().toString(36)}-${Math.floor(random() * 2 ** 32).toString(36)}${Math.floor(random() * 2 ** 32).toString(36)}`;
  return `pack-purchase:${unique}`.slice(0, 80);
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

/** The id a type, design or size is saved under: its global id when it has one. */
export const packingNodeRef = (node) => text(node?.global_id) || text(node?.id);

/**
 * Opening a type, design or size form on the Frooz Pack screen (`view` is `packingManageView`).
 *
 * The parent is recorded here, when the form opens, and the form is saved against it. It used to be
 * read from the drill-down at Save time, so pressing Edit on a size, browsing into another design
 * and pressing Save moved the size, with its count, purchases and combo links, under the design on
 * screen. `where` is the heading's "in Gift Box › Window Box", fixed at the same moment.
 */
export const startPackingNodeForm = (kind, node = null, view = {}) => {
  const which = text(kind).toLowerCase();
  const common = { sort_order: node ? String(node.sort_order ?? 0) : "0", active: node ? node.active !== false : true };
  const draft = which === "size"
    ? {
      ...common,
      size_name: node?.size_name || "CLASSIC",
      capacity: node?.capacity || "",
      unit_cost: node && Number.isFinite(node.unit_cost) && node.unit_cost > 0 ? String(node.unit_cost) : "",
    }
    : { ...common, name: node?.name || "" };
  const parent = which === "design"
    ? { type_id: packingNodeRef(view?.type) }
    : which === "size" ? { design_id: packingNodeRef(view?.design) } : {};
  const crumbs = Array.isArray(view?.crumbs) ? view.crumbs : [];
  const where = which !== "type" && crumbs.length > 1
    ? crumbs.slice(1).map((crumb) => text(crumb?.label)).filter(Boolean).join(" › ")
    : "";
  return { kind: which, ref: node ? packingNodeRef(node) : "", draft, parent, where, inUse: node?.in_use === true, error: "", saving: false };
};

/** A node form checked for Save: its own fields, under the parent it was opened in. */
export const checkPackingNodeForm = (form) => validatePackingNode(form?.kind, { ...(form?.draft || {}), ...(form?.parent || {}) });

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
// New packing in one go: Type → Design → the sizes ticked (POST /api/v3/packing/setup)
// ---------------------------------------------------------------------------------------------

/** What Quick start makes when the shop has no packing types at all. */
export const PACKING_QUICK_START_TYPES = Object.freeze(["Gift Box", "Basket", "Bottle", "Bowl"]);

/** Quick start is offered only on a list that loaded and has no type at all (on or off). */
export const packingQuickStartOffered = (catalogue) => (
  !Array.isArray(catalogue) && text(catalogue?.status) === "ready" && catalogueTypes(catalogue).length === 0
);

const collapse = (value) => text(value).replace(/\s+/g, " ");
const sameName = (left, right) => collapse(left).toLowerCase() === collapse(right).toLowerCase();
const activeTypes = (catalogue) => catalogueTypes(catalogue).filter((type) => type && type.active !== false);
const activeDesigns = (type) => (Array.isArray(type?.designs) ? type.designs : []).filter((design) => design && design.active !== false);

/**
 * A blank New-packing form. `typeId` / `designId` start it where the owner already is (the
 * module's drill-down), so "New packing" inside Gift Box › Window Box only asks for sizes. An
 * empty id means "a new one", named in `type_name` / `design_name`.
 */
export const createPackingSetupDraft = ({ typeId = "", designId = "" } = {}) => ({
  type_id: canonicalInventoryId(typeId),
  type_name: "",
  design_id: canonicalInventoryId(typeId) ? canonicalInventoryId(designId) : "",
  design_name: "",
  sizes: PACKING_SIZE_NAMES.map((size_name) => ({ size_name, checked: false, capacity: "", unit_cost: "" })),
});

/**
 * Where "New packing" starts from the module: inside the type (and design) on screen. The form
 * offers only switched-on types and designs, so seeding a switched-off one gave a Type list showing
 * "+ New type…" with no name box, and Save said "That packing type is no longer in the list". It
 * starts as far in as the form can follow instead, with `note` saying why it is not further.
 */
export const packingSetupStart = (catalogue, { typeId = "", designId = "" } = {}) => {
  const choices = packingSetupChoices(catalogue, { type_id: text(typeId), design_id: text(designId) });
  const offNote = (name) => `${name || "That one"} is switched off. Switch it on (Edit) to add packing under it.`;
  if (text(typeId) !== "" && !choices.type) {
    const type = catalogueTypes(catalogue).find((entry) => entry && nodeMatches(entry, typeId));
    return { draft: createPackingSetupDraft(), note: type ? offNote(type.name) : "" };
  }
  if (choices.type && text(designId) !== "" && !choices.design) {
    const design = (Array.isArray(choices.type.designs) ? choices.type.designs : []).find((entry) => entry && nodeMatches(entry, designId));
    return { draft: createPackingSetupDraft({ typeId: choices.type.id }), note: design ? offNote(design.name) : "" };
  }
  return { draft: createPackingSetupDraft({ typeId, designId }), note: "" };
};

/**
 * What the New-packing form offers for `draft`: the switched-on types, the switched-on designs of
 * the chosen type, and the sizes the chosen design already has (so the owner sees them before
 * ticking a duplicate). A type or design with no size yet is offered: this is where it gets one.
 */
export const packingSetupChoices = (catalogue, draft = {}) => {
  const types = activeTypes(catalogue);
  const type = text(draft?.type_id) ? types.find((entry) => nodeMatches(entry, draft.type_id)) || null : null;
  const designs = type ? activeDesigns(type) : [];
  const design = type && text(draft?.design_id) ? designs.find((entry) => nodeMatches(entry, draft.design_id)) || null : null;
  return {
    types: types.map((entry) => ({ id: entry.id, label: entry.name })),
    designs: designs.map((entry) => ({ id: entry.id, label: entry.name })),
    existingSizes: design ? activeSizes(design).map((size) => packingSizeLabel(size)) : [],
    type,
    design,
  };
};

/**
 * The body `POST /api/v3/packing/setup` takes, checked as the server checks it, or the first
 * problem in words. A typed name that is already a switched-on type (or design of the chosen
 * type), in any case, is taken as that one rather than refused as a duplicate. A size the design
 * already has, switched on, is refused here naming it. `summary` is what was made, for the notice.
 */
export const buildPackingSetupPayload = (draft = {}, catalogue = null) => {
  const types = activeTypes(catalogue);
  let type;
  let typeName = "";
  if (text(draft?.type_id)) {
    type = types.find((entry) => nodeMatches(entry, draft.type_id)) || null;
    if (!type) return refuse("That packing type is no longer in the list. Choose it again.");
  } else {
    typeName = collapse(draft?.type_name);
    if (typeName === "") return refuse("Choose a packing type, or type a name for a new one.");
    if (typeName.length > 80) return refuse("Keep the packing type name to 80 letters or fewer.");
    type = types.find((entry) => sameName(entry.name, typeName)) || null;
  }

  let design;
  let designName = "";
  if (type && text(draft?.design_id)) {
    design = activeDesigns(type).find((entry) => nodeMatches(entry, draft.design_id)) || null;
    if (!design) return refuse(`That design is no longer under ${type.name}. Choose it again.`);
  } else {
    designName = collapse(draft?.design_name);
    if (designName.length > 80) return refuse("Keep the design name to 80 letters or fewer.");
    design = designName !== "" && type ? activeDesigns(type).find((entry) => sameName(entry.name, designName)) || null : null;
  }

  const sizes = [];
  for (const row of Array.isArray(draft?.sizes) ? draft.sizes : []) {
    if (!row?.checked) continue;
    const sizeName = upper(row.size_name);
    const label = PACKING_SIZE_LABELS[sizeName];
    if (!label) return refuse("Choose a size: Petite, Classic, Grand or Royal.");
    const capacity = collapse(row.capacity);
    if (capacity.length > 40) return refuse(`${label}: keep the capacity to 40 letters or fewer (for example 1 kg or 300 ml).`);
    const size = { size_name: sizeName, capacity };
    if (text(row.unit_cost) !== "") {
      const unitCost = finiteOrNull(row.unit_cost);
      if (unitCost === null || unitCost < 0 || !hasAtMostDecimals(row.unit_cost, 2)) {
        return refuse(`${label}: the unit cost must be ₹0 or more, with at most 2 decimals.`);
      }
      size.unit_cost = unitCost;
    }
    if (sizes.some((other) => other.size_name === size.size_name && sameName(other.capacity, size.capacity))) {
      return refuse(`${packingSizeLabel(size)} is ticked twice.`);
    }
    sizes.push(size);
  }

  const hasDesign = Boolean(design) || designName !== "";
  if (!hasDesign && sizes.length > 0) return refuse("Choose the design these sizes belong to, or type a name for a new one.");
  if (hasDesign && sizes.length === 0) return refuse("Tick at least one size: Petite, Classic, Grand or Royal. A design with no size cannot be picked anywhere.");
  if (!hasDesign && type) return refuse(`${type.name} is already there. Choose or name a design and tick its sizes.`);

  if (design) {
    const already = sizes.find((size) => activeSizes(design).some((existing) => upper(existing.size_name) === size.size_name && sameName(existing.capacity, size.capacity)));
    if (already) return refuse(`${design.name} already has ${packingSizeLabel(already)}. Untick it, or give it a different capacity.`);
  }

  const payload = {
    type: type ? { id: type.id } : { name: typeName },
    sizes,
  };
  if (design) payload.design = { id: design.id };
  else if (designName !== "") payload.design = { name: designName };
  const where = [type ? type.name : typeName, design ? design.name : designName].filter(Boolean).join(" › ");
  const summary = sizes.length > 0 ? `${where}: ${sizes.map(packingSizeLabel).join(", ")}` : where;
  return { ok: true, payload, message: "", summary };
};

/**
 * The size a purchase line takes after "+ New packing" made it: the first size the server sent
 * back, as a picker row (`packing_size_id` is its global id). Null when no size was made.
 */
export const packingSetupPickRow = (body) => {
  const size = Array.isArray(body?.sizes) ? body.sizes.find((entry) => entry && typeof entry === "object") : null;
  if (!size) return null;
  const sizeId = text(size.global_id) || text(size.id);
  if (sizeId === "") return null;
  const cost = knownUnitCost(size.unit_cost);
  return {
    packing_size_id: sizeId,
    type_name: text(body?.type?.name),
    design_name: text(body?.design?.name),
    size_name: upper(size.size_name),
    capacity: text(size.capacity),
    unit_cost: cost,
    qty_on_hand: finiteOrNull(size.qty_on_hand),
  };
};

// ---------------------------------------------------------------------------------------------
// The purchase table: Packing → Qty → Rate → Amount, one row per line
// ---------------------------------------------------------------------------------------------

export const createPackingPurchaseLine = (key) => ({ key: text(key), size_id: "", label: "", quantity: "", rate: "" });

/** A line's amount (quantity × rate, half-up to the paisa, as the server works it) or null while unreadable. */
export const packingPurchaseLineAmount = (line) => {
  const quantity = finiteOrNull(line?.quantity);
  const rate = finiteOrNull(line?.rate);
  if (quantity === null || rate === null || quantity <= 0 || rate < 0) return null;
  const thousandths = toThousandths(quantity);
  const paise = toPaise(rate);
  return Math.floor((thousandths * paise * 2 + 1000) / 2000) / 100;
};

/** The running total of the lines whose amount can be worked out. */
export const packingPurchaseDraftTotal = (lines) => {
  let paise = 0;
  for (const line of Array.isArray(lines) ? lines : []) {
    const amount = packingPurchaseLineAmount(line);
    if (amount !== null) paise += Math.round(amount * 100);
  }
  return paise / 100;
};

/**
 * Put a picked size on line `key`. The rate starts at the size's last unit cost when it is known
 * and the line has no rate yet; a rate already typed is the bill's own and stays.
 */
export const applyPackingToPurchaseLine = (lines, key, row) => (Array.isArray(lines) ? lines : []).map((line) => {
  if (line?.key !== key || !row) return line;
  const cost = knownUnitCost(row.unit_cost);
  return {
    ...line,
    size_id: text(row.packing_size_id),
    label: packingPathLabel(row),
    rate: text(line.rate) !== "" ? line.rate : (cost === null ? "" : String(cost)),
  };
});

/**
 * Where Enter goes from `field` of line `key`: Qty → the same line's Rate; Rate → the next line's
 * Packing button, adding a fresh line (`makeLine()`) when this is the last. A blank trailing line
 * is dropped at save (`buildPackingPurchasePayload`), so it is never in the way.
 *
 * @returns {{lines: object[], focus: {key: string, field: "pick"|"quantity"|"rate"} | null}}
 */
export const advancePackingPurchaseLine = (lines, key, field, makeLine) => {
  const list = Array.isArray(lines) ? lines : [];
  const index = list.findIndex((line) => line?.key === key);
  if (index === -1) return { lines: list, focus: null };
  if (field === "pick") return { lines: list, focus: { key, field: "quantity" } };
  if (field === "quantity") return { lines: list, focus: { key, field: "rate" } };
  if (field !== "rate") return { lines: list, focus: null };
  if (index < list.length - 1) return { lines: list, focus: { key: list[index + 1].key, field: "pick" } };
  const fresh = typeof makeLine === "function" ? makeLine() : null;
  if (!fresh) return { lines: list, focus: null };
  return { lines: [...list, fresh], focus: { key: fresh.key, field: "pick" } };
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
