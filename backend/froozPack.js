"use strict";

/**
 * Frooz Pack: packing material as a stock item.
 *
 * ## What it is
 *
 * The owner keeps a three-level master, Type > Design > Size ("Gift Box" > "Window Box" > "Grand ·
 * 1 kg"). A size is one of PETITE, CLASSIC, GRAND, ROYAL plus free capacity text, and is a stock
 * item: a count on hand per branch (`packing_stock`) and a unit cost (the last purchase rate).
 *
 * - A packing purchase raises counts and writes one `expenses` row, category exactly
 *   'Packing Material', in the same transaction. That expense cannot be cancelled from Expenses
 *   (PACKING_PURCHASE_EXPENSE): there is no purchase cancel in v1, the owner corrects a count with an
 *   adjustment instead.
 * - A FIXED combo lists the packing it uses (`combo_packing`, via the combo routes and
 *   `combos.js`); a CUSTOM combo's packing is picked by the cashier at the counter.
 * - A desktop bill carries `packing_usage`; `recordSalePackingUsage` records it and reduces the
 *   counts. It NEVER refuses a bill -- the bill is in the customer's hands, and a rejection is
 *   stored and replayed forever -- so anything odd is skipped and written to the bill's audit trail,
 *   and a database failure is contained in a savepoint. A count may go negative.
 * - Cancelling a bill puts its packing back once (`restoreSalePacking`).
 * - Packing cost never enters a sale's cost or profit: it was expensed when it was bought.
 *
 * ## Sync
 *
 * Two company reference entity types (backend/syncReferenceBootstrap.js):
 * - `packing_type`: the whole tree of one type, designs and sizes nested, published after any write
 *   to the type, a design or a size and after a purchase (unit costs change). Combos that use a
 *   size of the type are republished with it, so a combo's packing names and costs stay current.
 * - `packing_stock`: one branch's count of one size, entity id
 *   'packing-stock-<branch_id>-<size global id>'. Logged once with the stock's branch; being a
 *   company reference type, every device of the company pulls it.
 *
 * The rules (validation, the tree, the payloads) are pure; the database work takes a `client`
 * and the server's sync loggers as `deps`, so every path here runs against PGlite in
 * froozPack.test.js. The company is always the session's (`req.auth.companyId`), the actor always
 * `req.auth.userId`, resolved by the server before anything here runs.
 */

const { COMBOS_WITH_ITEMS_SQL, unavailableProductsOf } = require("./combos");

const PACKING_SIZE_NAMES = Object.freeze(["PETITE", "CLASSIC", "GRAND", "ROYAL"]);
const PACKING_SIZE_LABELS = Object.freeze({ PETITE: "Petite", CLASSIC: "Classic", GRAND: "Grand", ROYAL: "Royal" });
const PACKING_PAYMENT_MODES = Object.freeze(["CASH", "UPI", "BANK_TRANSFER", "CHEQUE"]);
const PACKING_EXPENSE_CATEGORY = "Packing Material";
const MOVEMENT_TYPES = Object.freeze({ PURCHASE: "PURCHASE", SALE: "SALE", SALE_CANCEL: "SALE_CANCEL", ADJUST: "ADJUST" });
const USAGE_SOURCES = Object.freeze(["FIXED", "CUSTOM"]);

const CODES = Object.freeze({
  PERMISSION_REQUIRED: "PACKING_PERMISSION_REQUIRED",
  COMPANY_REQUIRED: "PACKING_COMPANY_REQUIRED",
  NAME_REQUIRED: "PACKING_NAME_REQUIRED",
  NAME_TAKEN: "PACKING_NAME_TAKEN",
  SIZE_NAME_INVALID: "PACKING_SIZE_NAME_INVALID",
  SIZE_TAKEN: "PACKING_SIZE_TAKEN",
  PARENT_INVALID: "PACKING_PARENT_INVALID",
  NOT_FOUND: "PACKING_NOT_FOUND",
  INPUT_INVALID: "PACKING_INPUT_INVALID",
  PURCHASE_INVALID: "PACKING_PURCHASE_INVALID",
  ADJUSTMENT_INVALID: "PACKING_ADJUSTMENT_INVALID",
  PURCHASE_EXPENSE: "PACKING_PURCHASE_EXPENSE",
  USAGE_SKIPPED: "PACKING_USAGE_SKIPPED",
  STORAGE_MISSING: "PACKING_STORAGE_MISSING",
  LOAD_FAILED: "PACKING_LOAD_FAILED",
  SAVE_FAILED: "PACKING_SAVE_FAILED",
});

const MESSAGES = Object.freeze({
  PURCHASE_EXPENSE: "This expense belongs to a Frooz Pack purchase.",
  PERMISSION_REQUIRED: "Only the Owner or an Admin can manage Frooz Pack.",
  COMPANY_REQUIRED: "This session has no shop and branch to keep packing for. Sign in at a counter of the shop.",
  STORAGE_MISSING: "Frooz Pack is not set up on this server yet. Ask the administrator to update the database.",
});

const NAME_MAX = 80;
const CAPACITY_MAX = 40;
const SUPPLIER_MAX = 160;
const REFERENCE_MAX = 80;
const REMARKS_MAX = 1000;
const MONEY_MAX = 10_000_000;
const QUANTITY_MAX = 1_000_000_000;
const LINES_MAX = 200;
const INT_MAX = 2_147_483_647;

// ---------------------------------------------------------------------------------------------
// Numbers and text
// ---------------------------------------------------------------------------------------------

const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;
const roundQuantity = (value) => Math.sign(Number(value)) * Math.round(Math.abs(Number(value)) * 1000 + 1e-7) / 1000;

/** A number, or null for null/undefined/blank/non-numeric/boolean. Zero is a number. */
const finiteOrNull = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");
const text = (value) => (typeof value === "string" ? value.trim() : (typeof value === "number" && Number.isFinite(value) ? String(value) : ""));
const positiveInt = (value) => {
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) && number > 0 && number <= INT_MAX ? number : null;
};

/**
 * An id as the API accepts it: the integer id or the global id. Ids are opaque, so only a plain
 * positive integer with no leading zero ("12", 12) is also tried as the numeric id; "012" is a
 * global id that matches nothing numeric.
 */
const readRef = (value) => {
  const ref = text(value).slice(0, 80);
  if (!ref) return null;
  const intId = /^[1-9]\d{0,9}$/.test(ref) && Number(ref) <= INT_MAX ? Number(ref) : null;
  return { ref, intId };
};

const refuse = (code, message, status = 400) => ({ ok: false, status, code, message });

/** `active` as sent: true/false, or null when absent (create: on; update: keep). */
const readActive = (value) => {
  if (value === undefined || value === null) return null;
  if (value === false || value === 0 || (typeof value === "string" && ["false", "0", "no"].includes(value.trim().toLowerCase()))) return false;
  return true;
};

/** `sort_order` as sent: a whole number, or null when absent/invalid (create: 0; update: keep). */
const readSortOrder = (value) => {
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) && Math.abs(number) <= INT_MAX ? number : null;
};

const readName = (value, what) => {
  const name = text(value).replace(/\s+/g, " ");
  if (!name) return refuse(CODES.NAME_REQUIRED, `Enter a name for this ${what}.`);
  if (name.length > NAME_MAX) return refuse(CODES.NAME_REQUIRED, `Keep the ${what} name to ${NAME_MAX} letters or fewer.`);
  return { ok: true, value: name };
};

// ---------------------------------------------------------------------------------------------
// Validation: what the master routes may store
// ---------------------------------------------------------------------------------------------

/** POST/PUT /api/v3/packing/types: {name, active?, sort_order?}. */
const validateTypeInput = (body = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const name = readName(input.name, "packing type");
  if (!name.ok) return name;
  return { ok: true, value: { name: name.value, active: readActive(input.active), sort_order: readSortOrder(input.sort_order) } };
};

/**
 * POST/PUT /api/v3/packing/designs: {type_id, name, active?, sort_order?}. `type_id` is required to
 * create; on an update an absent one keeps the design where it is.
 */
const validateDesignInput = (body = {}, { updating = false } = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const typeRef = readRef(input.type_id ?? input.type_global_id);
  if (!typeRef && !updating) return refuse(CODES.PARENT_INVALID, "Choose the packing type this design belongs to.");
  const name = readName(input.name, "design");
  if (!name.ok) return name;
  return {
    ok: true,
    value: { type_ref: typeRef, name: name.value, active: readActive(input.active), sort_order: readSortOrder(input.sort_order) },
  };
};

/**
 * POST/PUT /api/v3/packing/sizes: {design_id, size_name, capacity?, unit_cost?, active?,
 * sort_order?}. `size_name` is one of PACKING_SIZE_NAMES (case-insensitive); anything else is
 * PACKING_SIZE_NAME_INVALID. An absent `unit_cost` is 0 on create and kept on update.
 */
const validateSizeInput = (body = {}, { updating = false } = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const designRef = readRef(input.design_id ?? input.design_global_id);
  if (!designRef && !updating) return refuse(CODES.PARENT_INVALID, "Choose the design this size belongs to.");
  const sizeName = text(input.size_name).toUpperCase();
  if (!PACKING_SIZE_NAMES.includes(sizeName)) {
    return refuse(CODES.SIZE_NAME_INVALID, "Choose the size: Petite, Classic, Grand or Royal.");
  }
  const capacity = text(input.capacity).replace(/\s+/g, " ");
  if (capacity.length > CAPACITY_MAX) return refuse(CODES.INPUT_INVALID, `Keep the capacity to ${CAPACITY_MAX} letters or fewer.`);
  let unitCost = null;
  if (!isBlank(input.unit_cost)) {
    const parsed = finiteOrNull(input.unit_cost);
    if (parsed === null || parsed < 0 || parsed > MONEY_MAX) return refuse(CODES.INPUT_INVALID, "Enter the unit cost as an amount of zero or more.");
    unitCost = roundMoney(parsed);
  }
  return {
    ok: true,
    value: {
      design_ref: designRef,
      size_name: sizeName,
      capacity: capacity || null,
      unit_cost: unitCost,
      active: readActive(input.active),
      sort_order: readSortOrder(input.sort_order),
    },
  };
};

const isCalendarDate = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

/**
 * POST /api/v3/packing/purchases: {supplier_name?, purchase_date (YYYY-MM-DD, default `today`),
 * payment_mode (CASH|UPI|BANK_TRANSFER|CHEQUE), reference_number?, remarks?, lines:[{size_id,
 * quantity > 0, rate >= 0}]}. Each line's amount is round2(quantity x rate); the purchase's amount
 * is their sum, and must be above zero because it becomes an expense.
 */
const validatePurchaseInput = (body = {}, { today } = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const supplierName = text(input.supplier_name).replace(/\s+/g, " ");
  if (supplierName.length > SUPPLIER_MAX) return refuse(CODES.PURCHASE_INVALID, `Keep the supplier name to ${SUPPLIER_MAX} letters or fewer.`);
  const purchaseDate = isBlank(input.purchase_date) ? text(today) : text(input.purchase_date);
  if (!isCalendarDate(purchaseDate)) return refuse(CODES.PURCHASE_INVALID, "Enter the purchase date as YYYY-MM-DD.");
  const paymentMode = text(input.payment_mode).toUpperCase();
  if (!PACKING_PAYMENT_MODES.includes(paymentMode)) {
    return refuse(CODES.PURCHASE_INVALID, "Choose how the purchase was paid: Cash, UPI, Bank transfer or Cheque.");
  }
  const referenceNumber = text(input.reference_number);
  if (referenceNumber.length > REFERENCE_MAX) return refuse(CODES.PURCHASE_INVALID, `Keep the reference number to ${REFERENCE_MAX} letters or fewer.`);
  const remarks = text(input.remarks);
  if (remarks.length > REMARKS_MAX) return refuse(CODES.PURCHASE_INVALID, `Keep the remarks to ${REMARKS_MAX} letters or fewer.`);
  if (!Array.isArray(input.lines) || input.lines.length === 0) return refuse(CODES.PURCHASE_INVALID, "Add at least one packing line to the purchase.");
  if (input.lines.length > LINES_MAX) return refuse(CODES.PURCHASE_INVALID, `A purchase can have at most ${LINES_MAX} lines.`);
  const lines = [];
  const seen = new Set();
  for (const raw of input.lines) {
    const sizeRef = readRef(raw?.size_id ?? raw?.packing_size_id);
    if (!sizeRef) return refuse(CODES.PURCHASE_INVALID, "Every purchase line needs a packing size.");
    if (seen.has(sizeRef.ref)) return refuse(CODES.PURCHASE_INVALID, "A packing size appears twice in this purchase. Put it once, with the total quantity.");
    seen.add(sizeRef.ref);
    const quantity = finiteOrNull(raw?.quantity);
    if (quantity === null || quantity <= 0 || quantity > QUANTITY_MAX || roundQuantity(quantity) <= 0) {
      return refuse(CODES.PURCHASE_INVALID, "Every purchase line needs a quantity above zero.");
    }
    const rate = finiteOrNull(raw?.rate);
    if (rate === null || rate < 0 || rate > MONEY_MAX) return refuse(CODES.PURCHASE_INVALID, "Every purchase line needs a rate of zero or more.");
    const roundedQuantity = roundQuantity(quantity);
    const roundedRate = roundMoney(rate);
    lines.push({ size_ref: sizeRef, quantity: roundedQuantity, rate: roundedRate, amount: roundMoney(roundedQuantity * roundedRate) });
  }
  const amount = roundMoney(lines.reduce((sum, line) => sum + line.amount, 0));
  if (amount <= 0) return refuse(CODES.PURCHASE_INVALID, "A packing purchase needs an amount above zero. To record packing received free, use an adjustment.");
  return {
    ok: true,
    value: {
      supplier_name: supplierName || null,
      purchase_date: purchaseDate,
      payment_mode: paymentMode,
      reference_number: referenceNumber || null,
      remarks: remarks || null,
      lines,
      amount,
    },
  };
};

/** POST /api/v3/packing/adjustments: {size_id, quantity (signed, not 0), reason (required)}. */
const validateAdjustmentInput = (body = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const sizeRef = readRef(input.size_id ?? input.packing_size_id);
  if (!sizeRef) return refuse(CODES.ADJUSTMENT_INVALID, "Choose the packing size to adjust.");
  const quantity = finiteOrNull(input.quantity);
  if (quantity === null || Math.abs(quantity) > QUANTITY_MAX || roundQuantity(quantity) === 0) {
    return refuse(CODES.ADJUSTMENT_INVALID, "Enter the change in count: above zero to add, below zero to remove.");
  }
  const reason = text(input.reason);
  if (!reason) return refuse(CODES.ADJUSTMENT_INVALID, "Enter the reason for this adjustment.");
  if (reason.length > REMARKS_MAX) return refuse(CODES.ADJUSTMENT_INVALID, `Keep the reason to ${REMARKS_MAX} letters or fewer.`);
  return { ok: true, value: { size_ref: sizeRef, quantity: roundQuantity(quantity), reason } };
};

/**
 * A desktop bill's `packing_usage`, read leniently: rows that cannot be recorded (no size id, a
 * quantity that is not above zero) are set aside with a reason, never thrown on. Absent means
 * none. Strings are cut to their column widths.
 *
 * @returns {{rows: object[], skipped: {index: number|null, reason: string, row: any}[]}}
 */
const readSalePackingUsage = (raw) => {
  if (raw === undefined || raw === null) return { rows: [], skipped: [] };
  if (!Array.isArray(raw)) return { rows: [], skipped: [{ index: null, reason: "NOT_A_LIST", row: null }] };
  const rows = [];
  const skipped = [];
  for (const [index, entry] of raw.entries()) {
    if (!entry || typeof entry !== "object") {
      skipped.push({ index, reason: "NOT_AN_OBJECT", row: null });
      continue;
    }
    const sizeRef = text(entry.packing_size_id ?? entry.size_id).slice(0, 80);
    if (!sizeRef) {
      skipped.push({ index, reason: "SIZE_MISSING", row: entry });
      continue;
    }
    const quantity = finiteOrNull(entry.quantity);
    if (quantity === null || quantity <= 0 || quantity > QUANTITY_MAX || roundQuantity(quantity) <= 0) {
      skipped.push({ index, reason: "QUANTITY_INVALID", row: entry });
      continue;
    }
    const unitCost = finiteOrNull(entry.unit_cost);
    const source = text(entry.source).toUpperCase();
    rows.push({
      index,
      size_ref: sizeRef,
      combo_line_key: text(entry.combo_line_key).slice(0, 80) || null,
      combo_id: text(entry.combo_id).slice(0, 80) || null,
      source: USAGE_SOURCES.includes(source) ? source : (source.slice(0, 10) || null),
      type_name: text(entry.type_name).slice(0, 80) || null,
      design_name: text(entry.design_name).slice(0, 80) || null,
      size_name: text(entry.size_name).toUpperCase().slice(0, 20) || null,
      capacity: text(entry.capacity).slice(0, 40) || null,
      quantity: roundQuantity(quantity),
      unit_cost: unitCost !== null && unitCost >= 0 && unitCost <= MONEY_MAX ? roundMoney(unitCost) : null,
    });
  }
  return { rows, skipped };
};

// ---------------------------------------------------------------------------------------------
// The tree
// ---------------------------------------------------------------------------------------------

/**
 * Every packing type of a company with its designs and sizes as flat rows, in display order, and
 * each size's count at one branch.
 *
 * $1 company, $2 branch whose counts to join (NULL = none, qty 0), $3 type ids (NULL = all).
 */
const PACKING_TREE_SQL = `
  SELECT t.id AS type_id, COALESCE(t.global_id, 'packing-type-' || t.id::TEXT) AS type_global_id,
         t.company_id, t.name AS type_name, t.active AS type_active, t.sort_order AS type_sort_order,
         t.entity_version AS type_entity_version, t.updated_at AS type_updated_at,
         d.id AS design_id, COALESCE(d.global_id, 'packing-design-' || d.id::TEXT) AS design_global_id,
         d.name AS design_name, d.active AS design_active, d.sort_order AS design_sort_order,
         s.id AS size_id, COALESCE(s.global_id, 'packing-size-' || s.id::TEXT) AS size_global_id,
         s.size_name, s.capacity, s.unit_cost, s.active AS size_active, s.sort_order AS size_sort_order,
         stock.qty_on_hand
  FROM packing_types t
  LEFT JOIN packing_designs d ON d.type_id = t.id
  LEFT JOIN packing_sizes s ON s.design_id = d.id
  LEFT JOIN packing_stock stock ON stock.size_id = s.id AND stock.branch_id = $2::INTEGER
  WHERE t.company_id = $1
    AND ($3::INTEGER[] IS NULL OR t.id = ANY($3::INTEGER[]))
  ORDER BY t.sort_order, LOWER(t.name), t.id,
           d.sort_order, LOWER(d.name), d.id,
           s.sort_order,
           CASE s.size_name WHEN 'PETITE' THEN 1 WHEN 'CLASSIC' THEN 2 WHEN 'GRAND' THEN 3 WHEN 'ROYAL' THEN 4 ELSE 5 END,
           LOWER(COALESCE(s.capacity, '')), s.id
`;

/** Flat rows of PACKING_TREE_SQL as the nested tree `GET /api/v3/packing` answers with. */
const buildPackingTree = (rows) => {
  const types = [];
  const typeById = new Map();
  const designById = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    let type = typeById.get(row.type_id);
    if (!type) {
      type = {
        id: row.type_id,
        global_id: row.type_global_id,
        company_id: row.company_id ?? null,
        name: row.type_name,
        active: row.type_active !== false,
        sort_order: Number(row.type_sort_order || 0),
        entity_version: Number(row.type_entity_version || 1),
        updated_at: row.type_updated_at ?? null,
        designs: [],
      };
      typeById.set(row.type_id, type);
      types.push(type);
    }
    if (row.design_id === null || row.design_id === undefined) continue;
    let design = designById.get(row.design_id);
    if (!design) {
      design = {
        id: row.design_id,
        global_id: row.design_global_id,
        name: row.design_name,
        active: row.design_active !== false,
        sort_order: Number(row.design_sort_order || 0),
        sizes: [],
      };
      designById.set(row.design_id, design);
      type.designs.push(design);
    }
    if (row.size_id === null || row.size_id === undefined) continue;
    const qty = finiteOrNull(row.qty_on_hand);
    design.sizes.push({
      id: row.size_id,
      global_id: row.size_global_id,
      size_name: row.size_name,
      capacity: row.capacity ?? null,
      unit_cost: roundMoney(finiteOrNull(row.unit_cost) ?? 0),
      active: row.size_active !== false,
      sort_order: Number(row.size_sort_order || 0),
      qty_on_hand: qty === null ? 0 : roundQuantity(qty),
    });
  }
  return types;
};

/** One type of the tree as the `packing_type` sync change and the reference bootstrap carry it. */
const packingTypePayload = (type) => ({
  global_id: type.global_id,
  company_id: type.company_id ?? null,
  name: type.name,
  active: type.active !== false,
  sort_order: Number(type.sort_order || 0),
  entity_version: Number(type.entity_version || 1),
  designs: (type.designs || []).map((design) => ({
    global_id: design.global_id,
    name: design.name,
    active: design.active !== false,
    sort_order: Number(design.sort_order || 0),
    sizes: (design.sizes || []).map((size) => ({
      global_id: size.global_id,
      size_name: size.size_name,
      capacity: size.capacity ?? null,
      unit_cost: roundMoney(finiteOrNull(size.unit_cost) ?? 0),
      active: size.active !== false,
      sort_order: Number(size.sort_order || 0),
    })),
  })),
});

const packingStockEntityId = (branchId, sizeGlobalId) => `packing-stock-${branchId}-${sizeGlobalId}`;

/** A `packing_stock` row (joined to its size's global id) as the sync change carries it. */
const packingStockPayload = (row) => {
  const entityId = packingStockEntityId(row.branch_id, row.size_global_id);
  return {
    global_id: entityId,
    branch_id: Number(row.branch_id),
    size_global_id: row.size_global_id,
    qty_on_hand: roundQuantity(finiteOrNull(row.qty_on_hand) ?? 0),
    entity_version: Number(row.entity_version || 1),
    updated_at: row.updated_at ?? null,
  };
};

/**
 * Every `packing_stock` row of a company with its size's global id, as the reference bootstrap
 * carries them (all branches: the device keeps them all and its snapshot filters to its own).
 * $1 company.
 */
const PACKING_STOCK_SQL = `
  SELECT stock.branch_id, stock.qty_on_hand, stock.entity_version, stock.updated_at,
         COALESCE(s.global_id, 'packing-size-' || s.id::TEXT) AS size_global_id
  FROM packing_stock stock
  JOIN packing_sizes s ON s.id = stock.size_id
  JOIN packing_designs d ON d.id = s.design_id
  JOIN packing_types t ON t.id = d.type_id
  WHERE t.company_id = $1
    AND (stock.company_id IS NULL OR stock.company_id = $1)
  ORDER BY stock.branch_id, s.id
`;

// ---------------------------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------------------------

const loadPackingTree = async (client, { companyId, branchId = null, typeIds = null }) => {
  const result = await client.query(PACKING_TREE_SQL, [companyId, branchId || null, typeIds]);
  return buildPackingTree(result.rows);
};

/** Sizes of this company by id or global id: Map(ref -> size row with its design and type). */
const resolveSizes = async (client, { companyId, refs }) => {
  const list = (refs || []).filter(Boolean);
  if (list.length === 0) return new Map();
  const result = await client.query(
    `SELECT s.id, COALESCE(s.global_id, 'packing-size-' || s.id::TEXT) AS global_id, s.global_id AS stored_global_id,
            s.size_name, s.capacity, s.unit_cost, (s.active AND d.active AND t.active) AS active,
            d.id AS design_id, d.name AS design_name, t.id AS type_id, t.name AS type_name
     FROM packing_sizes s
     JOIN packing_designs d ON d.id = s.design_id
     JOIN packing_types t ON t.id = d.type_id
     WHERE t.company_id = $1
       AND (s.id = ANY($2::INTEGER[]) OR s.global_id = ANY($3::TEXT[]))`,
    [companyId, list.map((entry) => entry.intId).filter((id) => id !== null), list.map((entry) => entry.ref)]
  );
  const byGlobal = new Map(result.rows.filter((row) => row.stored_global_id).map((row) => [row.stored_global_id, row]));
  const byId = new Map(result.rows.map((row) => [Number(row.id), row]));
  const map = new Map();
  for (const entry of list) {
    const row = byGlobal.get(entry.ref) || (entry.intId !== null ? byId.get(entry.intId) : undefined);
    if (row) map.set(entry.ref, row);
  }
  return map;
};

/** Add `delta` (signed) to one branch's count of one size, creating the row at 0 first. */
const applyStockDelta = async (client, { companyId, branchId, sizeId, delta }) => {
  const result = await client.query(
    `INSERT INTO packing_stock (company_id, branch_id, size_id, qty_on_hand, entity_version, updated_at)
     VALUES ($1, $2, $3, $4, 1, now())
     ON CONFLICT (branch_id, size_id) DO UPDATE
       SET qty_on_hand = packing_stock.qty_on_hand + EXCLUDED.qty_on_hand,
           company_id = COALESCE(packing_stock.company_id, EXCLUDED.company_id),
           entity_version = packing_stock.entity_version + 1,
           updated_at = now()
     RETURNING branch_id, size_id, qty_on_hand, entity_version, updated_at`,
    [companyId || null, branchId, sizeId, delta]
  );
  return result.rows[0];
};

const insertMovement = async (client, { companyId, branchId, sizeId, movementType, quantity, saleId = null, purchaseId = null, reason = null, actorId = null }) => {
  const result = await client.query(
    `INSERT INTO packing_movements (company_id, branch_id, size_id, movement_type, quantity, sale_id, purchase_id, reason, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (sale_id, size_id, movement_type) WHERE sale_id IS NOT NULL DO NOTHING
     RETURNING id`,
    [companyId || null, branchId, sizeId, movementType, quantity, saleId, purchaseId, reason, actorId || null]
  );
  return result.rows[0] || null;
};

/**
 * Publish one branch's counts of these sizes as `packing_stock` changes, one change each, logged
 * with that branch (whose company every device of reads it). `deps.logSyncChange` is the server's.
 */
const publishPackingStock = async (client, { branchId, sizeIds }, deps) => {
  const ids = [...new Set((sizeIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0 || !branchId) return [];
  const result = await client.query(
    `SELECT stock.branch_id, stock.size_id, stock.qty_on_hand, stock.entity_version, stock.updated_at,
            COALESCE(s.global_id, 'packing-size-' || s.id::TEXT) AS size_global_id
     FROM packing_stock stock
     JOIN packing_sizes s ON s.id = stock.size_id
     WHERE stock.branch_id = $1 AND stock.size_id = ANY($2::INTEGER[])
     ORDER BY stock.size_id`,
    [branchId, ids]
  );
  const payloads = [];
  for (const row of result.rows) {
    const payload = packingStockPayload(row);
    await deps.logSyncChange(client, {
      branchId: Number(row.branch_id),
      entityType: "packing_stock",
      entityId: payload.global_id,
      operationType: "UPSERT",
      version: payload.entity_version,
      payload,
    });
    payloads.push(payload);
  }
  return payloads;
};

/**
 * Republish whole packing types (designs and sizes nested) as `packing_type` changes, anchored on a
 * branch of the company so every branch hears them (`deps.logMasterDataSyncChange`,
 * `deps.anchorBranchId` -- the combo routes' anchor logic). `bump` raises each type's version first,
 * so a device holding the old tree takes the new one. Combos using a size of these types are
 * republished too: their `packing` carries the names and unit costs.
 */
const publishPackingTypes = async (client, { companyId, typeIds, bump = true, preferredBranchId = null }, deps) => {
  const ids = [...new Set((typeIds || []).map(Number).filter((id) => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];
  if (bump) {
    await client.query(
      `UPDATE packing_types
       SET entity_version = COALESCE(entity_version, 1) + 1, updated_at = now()
       WHERE id = ANY($1::INTEGER[]) AND company_id = $2`,
      [ids, companyId]
    );
  }
  const types = await loadPackingTree(client, { companyId, typeIds: ids });
  const anchorBranchId = await deps.anchorBranchId(client, companyId, preferredBranchId);
  const payloads = [];
  for (const type of types) {
    const payload = packingTypePayload(type);
    await deps.logMasterDataSyncChange(client, {
      branchId: anchorBranchId,
      entityType: "packing_type",
      entityId: payload.global_id,
      operationType: "UPSERT",
      version: payload.entity_version,
      payload,
    });
    payloads.push(payload);
  }

  const combos = await client.query(
    `SELECT DISTINCT cp.combo_id
     FROM combo_packing cp
     JOIN packing_sizes s ON s.id = cp.size_id
     JOIN packing_designs d ON d.id = s.design_id
     JOIN combos c ON c.id = cp.combo_id
     WHERE d.type_id = ANY($1::INTEGER[])
       AND (c.company_id IS NULL OR c.company_id = $2)`,
    [ids, companyId]
  );
  const comboIds = combos.rows.map((row) => Number(row.combo_id));
  if (comboIds.length > 0) {
    await client.query(
      "UPDATE combos SET entity_version = COALESCE(entity_version, 1) + 1 WHERE id = ANY($1::INTEGER[]) AND (company_id IS NULL OR company_id = $2)",
      [comboIds, companyId]
    );
    const saved = await client.query(COMBOS_WITH_ITEMS_SQL, [companyId, comboIds, null]);
    for (const row of saved.rows) {
      await deps.logMasterDataSyncChange(client, {
        branchId: anchorBranchId,
        entityType: "combo",
        entityId: row.global_id,
        operationType: "UPSERT",
        version: Number(row.entity_version || 1),
        payload: { ...row, unavailable_products: unavailableProductsOf(row) },
      });
    }
  }
  return payloads;
};

// ---------------------------------------------------------------------------------------------
// Route work. Each runs inside the server's transaction, after it has checked the session's
// Owner/Admin authority (`requireRateManager(req.auth.userId)`) and its company and branch, and
// answers {status, body}; a status >= 400 rolls the transaction back.
// ---------------------------------------------------------------------------------------------

const answer = (status, body) => ({ status, body });
const refusal = (failure) => answer(failure.status || 400, { code: failure.code, message: failure.message });
const notFound = (what) => answer(404, { code: CODES.NOT_FOUND, message: `This ${what} was not found.` });

/** GET /api/v3/packing: the company's tree with the session branch's counts. */
const listPacking = async (client, { companyId, branchId }) => {
  if (!companyId) return { types: [] };
  return { types: await loadPackingTree(client, { companyId, branchId }) };
};

/** GET /api/v3/packing/movements?size_id=&limit= : the session branch's recent movements. */
const listPackingMovements = async (client, { companyId, branchId, sizeId, limit }) => {
  if (!companyId || !branchId) return { movements: [] };
  const sizeRef = readRef(sizeId);
  const parsedLimit = positiveInt(limit);
  const result = await client.query(
    `SELECT m.id, m.movement_type, m.quantity, m.sale_id, m.purchase_id, m.reason, m.created_by, m.created_at,
            s.id AS size_id, COALESCE(s.global_id, 'packing-size-' || s.id::TEXT) AS size_global_id,
            s.size_name, s.capacity, d.name AS design_name, t.name AS type_name
     FROM packing_movements m
     JOIN packing_sizes s ON s.id = m.size_id
     JOIN packing_designs d ON d.id = s.design_id
     JOIN packing_types t ON t.id = d.type_id
     WHERE m.branch_id = $1
       AND t.company_id = $2
       AND (m.company_id IS NULL OR m.company_id = $2)
       AND ($3::BOOLEAN IS FALSE OR s.id = $4::INTEGER OR s.global_id = $5::TEXT)
     ORDER BY m.created_at DESC, m.id DESC
     LIMIT $6`,
    [branchId, companyId, Boolean(sizeRef), sizeRef?.intId ?? null, sizeRef?.ref ?? null, Math.min(parsedLimit || 50, 500)]
  );
  return {
    movements: result.rows.map((row) => ({
      ...row,
      id: Number(row.id),
      quantity: roundQuantity(finiteOrNull(row.quantity) ?? 0),
    })),
  };
};

const findType = async (client, { companyId, ref, lock = false }) => {
  const result = await client.query(
    `SELECT id, name, active FROM packing_types
     WHERE (id = $1 OR global_id = $2) AND company_id = $3
     ${lock ? "FOR UPDATE" : ""}`,
    [ref.intId, ref.ref, companyId]
  );
  return result.rows[0] || null;
};

const findDesign = async (client, { companyId, ref, lock = false }) => {
  const result = await client.query(
    `SELECT d.id, d.type_id, d.name, d.active FROM packing_designs d
     JOIN packing_types t ON t.id = d.type_id
     WHERE (d.id = $1 OR d.global_id = $2) AND t.company_id = $3
     ${lock ? "FOR UPDATE OF d" : ""}`,
    [ref.intId, ref.ref, companyId]
  );
  return result.rows[0] || null;
};

const findSize = async (client, { companyId, ref, lock = false }) => {
  const result = await client.query(
    `SELECT s.id, s.design_id, d.type_id, s.size_name, s.capacity, s.active FROM packing_sizes s
     JOIN packing_designs d ON d.id = s.design_id
     JOIN packing_types t ON t.id = d.type_id
     WHERE (s.id = $1 OR s.global_id = $2) AND t.company_id = $3
     ${lock ? "FOR UPDATE OF s" : ""}`,
    [ref.intId, ref.ref, companyId]
  );
  return result.rows[0] || null;
};

const typeNode = async (client, { companyId, branchId, typeId }) =>
  (await loadPackingTree(client, { companyId, branchId, typeIds: [typeId] }))[0] || null;

/** POST /api/v3/packing/types (no `id`) or PUT /api/v3/packing/types/:id. */
const saveType = async (client, { companyId, branchId, actorId, id, body }, deps) => {
  const updating = id !== undefined;
  const parsed = validateTypeInput(body);
  if (!parsed.ok) return refusal(parsed);
  const input = parsed.value;
  let existing = null;
  if (updating) {
    const ref = readRef(id);
    existing = ref ? await findType(client, { companyId, ref, lock: true }) : null;
    if (!existing) return notFound("packing type");
  }
  const active = input.active ?? (existing ? existing.active !== false : true);
  if (active) {
    const clash = await client.query(
      `SELECT id FROM packing_types
       WHERE COALESCE(company_id, 0) = $1 AND LOWER(name) = LOWER($2) AND active AND id <> $3`,
      [companyId, input.name, existing ? existing.id : 0]
    );
    if (clash.rows.length > 0) return answer(409, { code: CODES.NAME_TAKEN, message: "Another active packing type already has this name." });
  }
  let typeId;
  if (updating) {
    typeId = existing.id;
    await client.query(
      `UPDATE packing_types
       SET name = $1, active = COALESCE($2, active), sort_order = COALESCE($3, sort_order),
           updated_by = $4, updated_at = now(), global_id = COALESCE(global_id, 'packing-type-' || id::TEXT)
       WHERE id = $5`,
      [input.name, input.active, input.sort_order, actorId, typeId]
    );
  } else {
    const created = await client.query(
      `INSERT INTO packing_types (company_id, name, active, sort_order, created_by, updated_by)
       VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, 0), $5, $5)
       RETURNING id`,
      [companyId, input.name, input.active, input.sort_order, actorId]
    );
    typeId = created.rows[0].id;
    await client.query("UPDATE packing_types SET global_id = 'packing-type-' || id::TEXT WHERE id = $1 AND global_id IS NULL", [typeId]);
  }
  await publishPackingTypes(client, { companyId, typeIds: [typeId], bump: updating, preferredBranchId: branchId }, deps);
  return answer(updating ? 200 : 201, { success: true, type: await typeNode(client, { companyId, branchId, typeId }) });
};

/** POST /api/v3/packing/designs or PUT /api/v3/packing/designs/:id. */
const saveDesign = async (client, { companyId, branchId, actorId, id, body }, deps) => {
  const updating = id !== undefined;
  const parsed = validateDesignInput(body, { updating });
  if (!parsed.ok) return refusal(parsed);
  const input = parsed.value;
  let existing = null;
  if (updating) {
    const ref = readRef(id);
    existing = ref ? await findDesign(client, { companyId, ref, lock: true }) : null;
    if (!existing) return notFound("design");
  }
  let typeId = existing ? existing.type_id : null;
  if (input.type_ref) {
    const type = await findType(client, { companyId, ref: input.type_ref });
    if (!type) return answer(400, { code: CODES.PARENT_INVALID, message: "The packing type for this design was not found. Pick it again." });
    typeId = type.id;
  }
  const active = input.active ?? (existing ? existing.active !== false : true);
  if (active) {
    const clash = await client.query(
      "SELECT id FROM packing_designs WHERE type_id = $1 AND LOWER(name) = LOWER($2) AND active AND id <> $3",
      [typeId, input.name, existing ? existing.id : 0]
    );
    if (clash.rows.length > 0) return answer(409, { code: CODES.NAME_TAKEN, message: "This packing type already has an active design with this name." });
  }
  let designId;
  if (updating) {
    designId = existing.id;
    await client.query(
      `UPDATE packing_designs
       SET type_id = $1, name = $2, active = COALESCE($3, active), sort_order = COALESCE($4, sort_order),
           updated_by = $5, updated_at = now(), global_id = COALESCE(global_id, 'packing-design-' || id::TEXT)
       WHERE id = $6`,
      [typeId, input.name, input.active, input.sort_order, actorId, designId]
    );
  } else {
    const created = await client.query(
      `INSERT INTO packing_designs (type_id, name, active, sort_order, created_by, updated_by)
       VALUES ($1, $2, COALESCE($3, TRUE), COALESCE($4, 0), $5, $5)
       RETURNING id`,
      [typeId, input.name, input.active, input.sort_order, actorId]
    );
    designId = created.rows[0].id;
    await client.query("UPDATE packing_designs SET global_id = 'packing-design-' || id::TEXT WHERE id = $1 AND global_id IS NULL", [designId]);
  }
  const typeIds = [typeId, existing ? existing.type_id : null].filter(Boolean);
  await publishPackingTypes(client, { companyId, typeIds, preferredBranchId: branchId }, deps);
  const type = await typeNode(client, { companyId, branchId, typeId });
  return answer(updating ? 200 : 201, {
    success: true,
    design: type ? type.designs.find((design) => design.id === designId) || null : null,
    type,
  });
};

/** POST /api/v3/packing/sizes or PUT /api/v3/packing/sizes/:id. */
const saveSize = async (client, { companyId, branchId, actorId, id, body }, deps) => {
  const updating = id !== undefined;
  const parsed = validateSizeInput(body, { updating });
  if (!parsed.ok) return refusal(parsed);
  const input = parsed.value;
  let existing = null;
  if (updating) {
    const ref = readRef(id);
    existing = ref ? await findSize(client, { companyId, ref, lock: true }) : null;
    if (!existing) return notFound("packing size");
  }
  let designId = existing ? existing.design_id : null;
  let typeId = existing ? existing.type_id : null;
  if (input.design_ref) {
    const design = await findDesign(client, { companyId, ref: input.design_ref });
    if (!design) return answer(400, { code: CODES.PARENT_INVALID, message: "The design for this size was not found. Pick it again." });
    designId = design.id;
    typeId = design.type_id;
  }
  const active = input.active ?? (existing ? existing.active !== false : true);
  if (active) {
    const clash = await client.query(
      `SELECT id FROM packing_sizes
       WHERE design_id = $1 AND size_name = $2 AND LOWER(COALESCE(capacity, '')) = LOWER(COALESCE($3::TEXT, ''))
         AND active AND id <> $4`,
      [designId, input.size_name, input.capacity, existing ? existing.id : 0]
    );
    if (clash.rows.length > 0) {
      return answer(409, { code: CODES.SIZE_TAKEN, message: "This design already has an active size with this name and capacity." });
    }
  }
  let sizeId;
  if (updating) {
    sizeId = existing.id;
    await client.query(
      `UPDATE packing_sizes
       SET design_id = $1, size_name = $2, capacity = $3, unit_cost = COALESCE($4, unit_cost),
           active = COALESCE($5, active), sort_order = COALESCE($6, sort_order),
           updated_by = $7, updated_at = now(), global_id = COALESCE(global_id, 'packing-size-' || id::TEXT)
       WHERE id = $8`,
      [designId, input.size_name, input.capacity, input.unit_cost, input.active, input.sort_order, actorId, sizeId]
    );
  } else {
    const created = await client.query(
      `INSERT INTO packing_sizes (design_id, size_name, capacity, unit_cost, active, sort_order, created_by, updated_by)
       VALUES ($1, $2, $3, COALESCE($4, 0), COALESCE($5, TRUE), COALESCE($6, 0), $7, $7)
       RETURNING id`,
      [designId, input.size_name, input.capacity, input.unit_cost, input.active, input.sort_order, actorId]
    );
    sizeId = created.rows[0].id;
    await client.query("UPDATE packing_sizes SET global_id = 'packing-size-' || id::TEXT WHERE id = $1 AND global_id IS NULL", [sizeId]);
  }
  const typeIds = [typeId, existing ? existing.type_id : null].filter(Boolean);
  await publishPackingTypes(client, { companyId, typeIds, preferredBranchId: branchId }, deps);
  const type = await typeNode(client, { companyId, branchId, typeId });
  const design = type ? type.designs.find((entry) => entry.id === designId) || null : null;
  return answer(updating ? 200 : 201, {
    success: true,
    size: design ? design.sizes.find((entry) => entry.id === sizeId) || null : null,
    type,
  });
};

/**
 * POST /api/v3/packing/purchases. One transaction: the purchase and its lines, each size's count up
 * at the session's branch with a PURCHASE movement, each size's unit cost set to the line's rate,
 * one 'Packing Material' expense for the total (its id stored on the purchase), then the counts
 * and the affected types published.
 */
const recordPackingPurchase = async (client, { companyId, branchId, actorId, body }, deps) => {
  const parsed = validatePurchaseInput(body, { today: deps.today() });
  if (!parsed.ok) return refusal(parsed);
  const purchase = parsed.value;
  const sizes = await resolveSizes(client, { companyId, refs: purchase.lines.map((line) => line.size_ref) });
  for (const line of purchase.lines) {
    const size = sizes.get(line.size_ref.ref);
    if (!size) return answer(400, { code: CODES.PURCHASE_INVALID, message: "A packing size in this purchase was not found. Pick it again." });
    if (size.active === false) {
      return answer(400, { code: CODES.PURCHASE_INVALID, message: `${size.type_name} › ${size.design_name} › ${PACKING_SIZE_LABELS[size.size_name] || size.size_name} is switched off. Switch it on to buy it.` });
    }
  }
  const sizeIds = purchase.lines.map((line) => Number(sizes.get(line.size_ref.ref).id));
  if (new Set(sizeIds).size !== sizeIds.length) {
    return answer(400, { code: CODES.PURCHASE_INVALID, message: "A packing size appears twice in this purchase. Put it once, with the total quantity." });
  }

  const created = await client.query(
    `INSERT INTO packing_purchases (
       company_id, branch_id, supplier_name, payment_mode, purchase_date, reference_number, remarks, amount, created_by
     )
     VALUES ($1, $2, $3, $4, $5::DATE, $6, $7, $8, $9)
     RETURNING id`,
    [companyId, branchId, purchase.supplier_name, purchase.payment_mode, purchase.purchase_date,
      purchase.reference_number, purchase.remarks, purchase.amount, actorId]
  );
  const purchaseId = created.rows[0].id;
  await client.query("UPDATE packing_purchases SET global_id = 'packing-purchase-' || id::TEXT WHERE id = $1 AND global_id IS NULL", [purchaseId]);

  const lines = [];
  for (const [index, line] of purchase.lines.entries()) {
    const size = sizes.get(line.size_ref.ref);
    const sizeId = sizeIds[index];
    await client.query(
      "INSERT INTO packing_purchase_lines (purchase_id, size_id, quantity, rate, amount) VALUES ($1, $2, $3, $4, $5)",
      [purchaseId, sizeId, line.quantity, line.rate, line.amount]
    );
    await applyStockDelta(client, { companyId, branchId, sizeId, delta: line.quantity });
    await insertMovement(client, {
      companyId, branchId, sizeId, movementType: MOVEMENT_TYPES.PURCHASE, quantity: line.quantity, purchaseId, actorId,
      reason: purchase.supplier_name ? `Bought from ${purchase.supplier_name}` : "Packing purchase",
    });
    await client.query("UPDATE packing_sizes SET unit_cost = $1, updated_by = $2, updated_at = now() WHERE id = $3", [line.rate, actorId, sizeId]);
    lines.push({
      size_id: size.global_id, type_name: size.type_name, design_name: size.design_name, size_name: size.size_name,
      capacity: size.capacity ?? null, quantity: line.quantity, rate: line.rate, amount: line.amount,
    });
  }

  const globalId = `packing-purchase-${purchaseId}`;
  const expense = await client.query(
    `INSERT INTO expenses (
       expense_date, category, amount, payment_mode, reference_number,
       vendor_name, paid_to, remarks, branch_id, created_by, active, status
     )
     VALUES ($1::DATE, $2, $3, $4, $5, $6, $6, $7, $8, $9, TRUE, 'ACTIVE')
     RETURNING id`,
    [purchase.purchase_date, PACKING_EXPENSE_CATEGORY, purchase.amount, purchase.payment_mode, purchase.reference_number,
      purchase.supplier_name, [`Frooz Pack purchase ${globalId}`, purchase.remarks].filter(Boolean).join(" -- "), branchId, actorId]
  );
  const expenseId = expense.rows[0].id;
  await client.query("UPDATE packing_purchases SET expense_id = $1 WHERE id = $2", [expenseId, purchaseId]);

  await publishPackingStock(client, { branchId, sizeIds }, deps);
  await publishPackingTypes(client, { companyId, typeIds: [...sizes.values()].map((size) => size.type_id), preferredBranchId: branchId }, deps);

  return answer(201, {
    success: true,
    purchase: {
      id: purchaseId,
      global_id: globalId,
      branch_id: branchId,
      supplier_name: purchase.supplier_name,
      payment_mode: purchase.payment_mode,
      purchase_date: purchase.purchase_date,
      reference_number: purchase.reference_number,
      remarks: purchase.remarks,
      amount: purchase.amount,
      expense_id: expenseId,
      lines,
    },
    expense_id: expenseId,
  });
};

/** POST /api/v3/packing/adjustments: a signed correction of the session branch's count. */
const recordPackingAdjustment = async (client, { companyId, branchId, actorId, body }, deps) => {
  const parsed = validateAdjustmentInput(body);
  if (!parsed.ok) return refusal(parsed);
  const adjustment = parsed.value;
  const sizes = await resolveSizes(client, { companyId, refs: [adjustment.size_ref] });
  const size = sizes.get(adjustment.size_ref.ref);
  if (!size) return answer(400, { code: CODES.ADJUSTMENT_INVALID, message: "This packing size was not found. Pick it again." });
  const sizeId = Number(size.id);
  await applyStockDelta(client, { companyId, branchId, sizeId, delta: adjustment.quantity });
  const movement = await insertMovement(client, {
    companyId, branchId, sizeId, movementType: MOVEMENT_TYPES.ADJUST, quantity: adjustment.quantity, reason: adjustment.reason, actorId,
  });
  const [stock] = await publishPackingStock(client, { branchId, sizeIds: [sizeId] }, deps);
  return answer(201, { success: true, movement_id: movement ? Number(movement.id) : null, stock });
};

// ---------------------------------------------------------------------------------------------
// Combos: the packing a FIXED combo uses
// ---------------------------------------------------------------------------------------------

/**
 * Resolve a combo request's packing lines (`combos.validateComboInput` -> value.packing) against
 * this company's sizes. Unknown or switched-off sizes are refused.
 *
 * @returns {{ok: true, lines: {size_id, quantity, sort_order}[]} | {ok: false, message: string}}
 */
const resolveComboPacking = async (client, { companyId, packing }) => {
  const list = Array.isArray(packing) ? packing : [];
  if (list.length === 0) return { ok: true, lines: [] };
  const refs = list.map((line) => readRef(line.size_ref)).filter(Boolean);
  if (refs.length !== list.length) return { ok: false, message: "A packing size in this combo was not found. Pick it again." };
  const sizes = await resolveSizes(client, { companyId, refs });
  const lines = [];
  for (const [index, line] of list.entries()) {
    const size = sizes.get(refs[index].ref);
    if (!size) return { ok: false, message: "A packing size in this combo was not found. Pick it again." };
    if (size.active === false) return { ok: false, message: "A packing size in this combo is switched off. Pick another, or switch it on in Frooz Pack." };
    lines.push({ size_id: Number(size.id), quantity: line.quantity, sort_order: line.sort_order });
  }
  if (new Set(lines.map((line) => line.size_id)).size !== lines.length) {
    return { ok: false, message: "A packing size appears twice in this combo. Put it once, with the total quantity." };
  }
  return { ok: true, lines };
};

/** Replace a combo's packing lines wholesale. */
const replaceComboPacking = async (client, { comboId, lines }) => {
  await client.query("DELETE FROM combo_packing WHERE combo_id = $1", [comboId]);
  for (const line of lines || []) {
    await client.query(
      "INSERT INTO combo_packing (combo_id, size_id, quantity, sort_order) VALUES ($1, $2, $3, $4)",
      [comboId, line.size_id, line.quantity, line.sort_order]
    );
  }
};

// ---------------------------------------------------------------------------------------------
// Sales
// ---------------------------------------------------------------------------------------------

/**
 * Run `work` inside a savepoint, so a database failure in the packing bookkeeping (a missing table,
 * a constraint) rolls back only the packing writes and leaves the bill's transaction usable. The
 * failure is logged, never thrown: packing never stops a bill or its cancellation.
 */
const contained = async (client, name, work, context) => {
  try {
    await client.query(`SAVEPOINT ${name}`);
  } catch (error) {
    console.warn("Frooz Pack bookkeeping skipped: no savepoint", { ...context, code: error?.code, message: error?.message });
    return null;
  }
  try {
    const result = await work();
    await client.query(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    console.warn("Frooz Pack bookkeeping failed and was rolled back; the bill stands", { ...context, code: error?.code, message: error?.message });
    try {
      await client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      await client.query(`RELEASE SAVEPOINT ${name}`);
    } catch (rollbackError) {
      console.warn("Frooz Pack savepoint rollback failed", { ...context, code: rollbackError?.code, message: rollbackError?.message });
    }
    return null;
  }
};

/**
 * After a desktop bill is written (processPosSaleFoundationOperation, after recordComboFindings):
 * record its `packing_usage` as billed and take the packing out of the branch's counts.
 *
 * - Never refuses. Rows without a size or a quantity above zero are skipped; rows naming a size
 *   this company does not have are kept in sale_packing_usage with size_id NULL and move no count.
 *   Both are written to the bill's audit trail (PACKING_USAGE_SKIPPED).
 * - Idempotent: a bill that already has usage rows is left alone, and SALE movements are unique
 *   per (sale, size), so a count is never taken twice.
 * - A bill with no `packing_usage` issues no query at all.
 *
 * @returns {Promise<{recorded: number, unknown: number, skipped: number, duplicate?: boolean} | null>}
 */
const recordSalePackingUsage = async (client, { saleId, companyId, branchId, actorId, usage }, deps) => {
  const parsed = readSalePackingUsage(usage);
  if (parsed.rows.length === 0 && parsed.skipped.length === 0) return { recorded: 0, unknown: 0, skipped: 0 };
  const sale = positiveInt(saleId);
  const branch = positiveInt(branchId);
  const company = positiveInt(companyId);
  if (!sale || !branch) {
    console.warn("Frooz Pack usage not recorded: the bill has no sale id or branch", { saleId, branchId });
    return null;
  }
  return contained(client, "frooz_pack_sale_usage", async () => {
    const already = await client.query("SELECT 1 FROM sale_packing_usage WHERE sale_id = $1 LIMIT 1", [sale]);
    if (already.rows.length > 0) return { recorded: 0, unknown: 0, skipped: 0, duplicate: true };

    const sizes = company
      ? await resolveSizes(client, { companyId: company, refs: parsed.rows.map((row) => readRef(row.size_ref)) })
      : new Map();
    const totals = new Map();
    const unknown = [];
    for (const row of parsed.rows) {
      const size = sizes.get(row.size_ref);
      const sizeId = size ? Number(size.id) : null;
      if (!size) unknown.push({ index: row.index, packing_size_id: row.size_ref, quantity: row.quantity });
      await client.query(
        `INSERT INTO sale_packing_usage (
           sale_id, combo_line_key, combo_id, source, size_id, size_global_id, type_name, design_name,
           size_name, capacity, quantity, unit_cost
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [sale, row.combo_line_key, row.combo_id, row.source, sizeId, size ? size.global_id : row.size_ref,
          row.type_name ?? size?.type_name ?? null, row.design_name ?? size?.design_name ?? null,
          row.size_name ?? size?.size_name ?? null, row.capacity ?? size?.capacity ?? null, row.quantity, row.unit_cost]
      );
      if (sizeId) totals.set(sizeId, roundQuantity((totals.get(sizeId) || 0) + row.quantity));
    }

    const moved = [];
    for (const [sizeId, quantity] of totals) {
      const movement = await insertMovement(client, {
        companyId: company, branchId: branch, sizeId, movementType: MOVEMENT_TYPES.SALE, quantity: -quantity, saleId: sale, actorId,
      });
      if (!movement) continue;
      await applyStockDelta(client, { companyId: company, branchId: branch, sizeId, delta: -quantity });
      moved.push(sizeId);
    }

    if (parsed.skipped.length > 0 || unknown.length > 0) {
      await client.query(
        `INSERT INTO sale_audit_trail (sale_id, action, field_name, old_value, new_value, reason, edited_by)
         VALUES ($1, $2, 'packing', NULL, $3::jsonb, $4, $5)`,
        [
          sale,
          CODES.USAGE_SKIPPED,
          JSON.stringify({
            skipped: parsed.skipped.map(({ index, reason }) => ({ index, reason })),
            unknown_sizes: unknown,
          }),
          `Packing on this bill was not counted: ${parsed.skipped.length} unreadable row(s), ${unknown.length} unknown size(s); the bill stands`,
          actorId || null,
        ]
      );
    }

    await publishPackingStock(client, { branchId: branch, sizeIds: moved }, deps);
    return { recorded: parsed.rows.length, unknown: unknown.length, skipped: parsed.skipped.length };
  }, { saleId: sale });
};

/**
 * After a bill is cancelled (sync and online paths, after restoreSaleInventory): put back the
 * packing its sale took, once. The SALE movements say what was taken from which branch; each gets
 * one SALE_CANCEL movement (unique per sale and size), so a replayed cancel puts nothing back twice.
 */
const restoreSalePacking = async (client, { saleId, companyId, actorId }, deps) => {
  const sale = positiveInt(saleId);
  if (!sale) return null;
  const company = positiveInt(companyId);
  return contained(client, "frooz_pack_sale_restore", async () => {
    const taken = await client.query(
      `SELECT branch_id, size_id, company_id, SUM(quantity) AS quantity
       FROM packing_movements
       WHERE sale_id = $1 AND movement_type = 'SALE'
         AND ($2::INTEGER IS NULL OR company_id IS NULL OR company_id = $2)
       GROUP BY branch_id, size_id, company_id`,
      [sale, company]
    );
    if (taken.rows.length === 0) return { restored: 0 };
    const byBranch = new Map();
    for (const row of taken.rows) {
      const quantity = roundQuantity(-(finiteOrNull(row.quantity) ?? 0));
      if (!(quantity > 0)) continue;
      const branchId = Number(row.branch_id);
      const sizeId = Number(row.size_id);
      const movement = await insertMovement(client, {
        companyId: row.company_id ?? company, branchId, sizeId, movementType: MOVEMENT_TYPES.SALE_CANCEL, quantity, saleId: sale, actorId,
        reason: "Bill cancelled",
      });
      if (!movement) continue;
      await applyStockDelta(client, { companyId: row.company_id ?? company, branchId, sizeId, delta: quantity });
      if (!byBranch.has(branchId)) byBranch.set(branchId, []);
      byBranch.get(branchId).push(sizeId);
    }
    let restored = 0;
    for (const [branchId, sizeIds] of byBranch) {
      await publishPackingStock(client, { branchId, sizeIds }, deps);
      restored += sizeIds.length;
    }
    return { restored };
  }, { saleId: sale });
};

/** Is this expense the one a packing purchase wrote? Expenses refuses to cancel it. */
const isPackingPurchaseExpense = async (client, expenseId) => {
  const result = await client.query("SELECT id FROM packing_purchases WHERE expense_id = $1 LIMIT 1", [expenseId]);
  return result.rows.length > 0;
};

/** A database error from a Frooz Pack write, as a response. */
const packingErrorResponse = (error) => {
  if (error?.code === "23505") {
    if (/packing_sizes/.test(String(error.constraint || ""))) {
      return answer(409, { code: CODES.SIZE_TAKEN, message: "This design already has an active size with this name and capacity." });
    }
    return answer(409, { code: CODES.NAME_TAKEN, message: "Another active entry here already has this name." });
  }
  if (error?.code === "23503") return answer(400, { code: CODES.PARENT_INVALID, message: "Something this entry points at was not found. Pick it again." });
  if (error?.code === "42P01") return answer(500, { code: CODES.STORAGE_MISSING, message: MESSAGES.STORAGE_MISSING });
  return answer(500, { code: CODES.SAVE_FAILED, message: "Frooz Pack could not be saved." });
};

module.exports = {
  CODES,
  MESSAGES,
  MOVEMENT_TYPES,
  PACKING_EXPENSE_CATEGORY,
  PACKING_PAYMENT_MODES,
  PACKING_SIZE_LABELS,
  PACKING_SIZE_NAMES,
  PACKING_STOCK_SQL,
  PACKING_TREE_SQL,
  applyStockDelta,
  buildPackingTree,
  isPackingPurchaseExpense,
  listPacking,
  listPackingMovements,
  loadPackingTree,
  packingErrorResponse,
  packingStockEntityId,
  packingStockPayload,
  packingTypePayload,
  publishPackingStock,
  publishPackingTypes,
  readRef,
  readSalePackingUsage,
  recordPackingAdjustment,
  recordPackingPurchase,
  recordSalePackingUsage,
  replaceComboPacking,
  resolveComboPacking,
  resolveSizes,
  restoreSalePacking,
  saveDesign,
  saveSize,
  saveType,
  validateAdjustmentInput,
  validateDesignInput,
  validatePurchaseInput,
  validateSizeInput,
  validateTypeInput,
};
