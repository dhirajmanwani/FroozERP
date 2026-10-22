"use strict";

/**
 * Combos & Offers: the rules about a combo, and about a sale line that belongs to one.
 *
 * Pure on purpose, like `productPosSection.js` and `saleReturns.js`: `server.js` calls these and
 * nothing here touches a database, so every rule is testable without one. The SQL that reads a
 * combo with its items is kept here as a constant (like `discounts.DISCOUNT_REPORT_SQL`) so the
 * master routes, the sync publish and the reference bootstrap all hand devices one shape.
 *
 * ## What a combo is
 *
 * - kind: COMBO_OFFER | THE_CUTTING | JUICE | GIFTING -- which POS tab shows it.
 * - type FIXED: the owner lists the component products and a quantity of each per combo, and a
 *   selling price per combo. On a bill its components are ordinary sale lines (one per product per
 *   lot, so stock, sync and reports keep working) whose amounts add up to price x combo_qty -- see
 *   `allocateFixedComboLines`.
 * - type CUSTOM (customer's choice): no fixed items, and the master's price stays empty. The
 *   cashier adds whatever the customer wants, and the counter works the combo's price out itself
 *   -- the cashier cannot type it -- as the items at their sale rates, raised by the combo's
 *   `margin_percent` (the owner's "bonus"; unset = 0%), plus its `extra_charge` (a making or
 *   basket charge per combo, >= 0), rounded by the Sale Rate rounding rule (Amendments 1 and 2).
 *   That price travels on the lines as `combo_price` and is spread over them exactly as a FIXED
 *   price is. The server stores the margin and extra charge but never recomputes a CUSTOM price
 *   from them: it checks only that the lines add up to `combo_price x combo_qty`.
 *
 * Either way the bill shows one price per combo, never the fruit rates, so every combo line --
 * FIXED or CUSTOM -- is priced by the offer, not by the cashier: `isComboPricedLine`.
 *
 * The allowed kinds and types are decided here and nowhere else: the tables carry no CHECK
 * constraint, the same choice migration 023 made for `products.pos_section`, so a new kind is a
 * code change and not a second migration.
 *
 * ## The sale-line fields
 *
 * `combo_line_key` (shared by every line of one combo in the cart), `combo_id` (the combo's
 * global id, "combo-12"), `combo_name`, `combo_kind`, `combo_type`, `combo_qty`, `combo_price`
 * (the price of one combo -- FIXED: the owner's; CUSTOM: items at sale rate + extra charge) and
 * `line_index` (cart order, on every line of the bill).
 * The name, kind, type and price are snapshots: a reprint next year shows what was sold, not what
 * the Combos screen says by then.
 */

const COMBO_KINDS = Object.freeze(["COMBO_OFFER", "THE_CUTTING", "JUICE", "GIFTING"]);
const COMBO_TYPES = Object.freeze(["FIXED", "CUSTOM"]);

/** The combo fields of a sale line. `line_index` is not one of them: every line carries it. */
const COMBO_LINE_FIELDS = Object.freeze([
  "combo_line_key", "combo_id", "combo_name", "combo_kind", "combo_type", "combo_qty", "combo_price",
]);
/** The `sale_items` columns this module fills, in the order `saleItemComboValues` returns them. */
const SALE_ITEM_COMBO_COLUMNS = Object.freeze([...COMBO_LINE_FIELDS, "line_index"]);

const CODES = Object.freeze({
  NAME_REQUIRED: "COMBO_NAME_REQUIRED",
  KIND_INVALID: "COMBO_KIND_INVALID",
  TYPE_INVALID: "COMBO_TYPE_INVALID",
  PRICE_INVALID: "COMBO_PRICE_INVALID",
  ITEMS_REQUIRED: "COMBO_ITEMS_REQUIRED",
  ITEM_INVALID: "COMBO_ITEM_INVALID",
  CHARGE_INVALID: "COMBO_CHARGE_INVALID",
  MARGIN_INVALID: "COMBO_MARGIN_INVALID",
  NOT_FOUND: "COMBO_NOT_FOUND",
  NAME_TAKEN: "COMBO_NAME_TAKEN",
  PERMISSION_REQUIRED: "COMBO_PERMISSION_REQUIRED",
  COUNTER_ONLY: "COMBO_COUNTER_ONLY",
  BILL_EDIT_UNSUPPORTED: "COMBO_BILL_EDIT_UNSUPPORTED",
  LINE_NOT_RETURNABLE: "COMBO_LINE_NOT_RETURNABLE",
  MISMATCH_ACCEPTED: "COMBO_MISMATCH_ACCEPTED",
  UNKNOWN_ACCEPTED: "COMBO_UNKNOWN_ACCEPTED",
  ALLOCATION_INVALID: "COMBO_ALLOCATION_INVALID",
});

const MESSAGES = Object.freeze({
  COUNTER_ONLY: "Combos and offers can be billed only from the counter app for now. Remove the combo from this bill, or bill it at the counter.",
  BILL_EDIT_UNSUPPORTED: "This bill has a combo on it, and a bill with a combo cannot be edited. Cancel the bill and make it again.",
  LINE_NOT_RETURNABLE: "This item was sold as part of a combo, and combo items cannot be returned one by one. Cancel the whole bill instead if it was wrong.",
});

const NAME_MAX = 120;
const DESCRIPTION_MAX = 1000;
const PRICE_MAX = 10_000_000;
const MARGIN_MAX = 1000;
const QUANTITY_SCALE = 1000;

// ---------------------------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------------------------

/** Exactly `roundCurrency` in server.js and the frontend: the server re-derives every line with it. */
const roundMoney = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100;


/** A number, or null for null/undefined/blank/non-numeric. Zero is a number. */
const finiteOrNull = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const isBlank = (value) => value === null || value === undefined || (typeof value === "string" && value.trim() === "");

const text = (value) => (typeof value === "string" ? value.trim() : (typeof value === "number" && Number.isFinite(value) ? String(value) : ""));

/** Ids are opaque: compared as trimmed text, never as numbers ("004" and 4 are different). */
const idKey = (value) => text(value);

const toThousandths = (value) => {
  const number = finiteOrNull(value);
  return number === null ? null : Math.round(number * QUANTITY_SCALE);
};

const cents = (value) => Math.round(roundMoney(value) * 100);

/**
 * Rupees as whole paise and a quantity as whole thousandths, half away from zero -- exactly
 * `toPaise` / `toThousandths` in frontend/src/local/combos.js, which the allocation must match to
 * the paisa.
 */
const toPaise = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.sign(number) * Math.round(Math.abs(number) * 100 + 1e-7);
};
const toThousandthsExact = (value) => {
  const number = finiteOrNull(value);
  if (number === null) return null;
  return Math.sign(number) * Math.round(Math.abs(number) * 1000 + 1e-7);
};

// ---------------------------------------------------------------------------------------------
// The master: what the Combos screen may store
// ---------------------------------------------------------------------------------------------

const refuse = (code, message) => ({ ok: false, code, message });

/**
 * A create/update request for a combo, checked and normalised, or a refusal.
 *
 * Product and charge existence need the database; the route checks those and answers with
 * COMBO_ITEM_INVALID / COMBO_CHARGE_INVALID itself. Everything decidable from the request alone is
 * decided here.
 *
 * @returns {{ok: true, value: object} | {ok: false, code: string, message: string}}
 */
const validateComboInput = (body = {}) => {
  const input = body && typeof body === "object" ? body : {};
  const name = text(input.name);
  if (!name) return refuse(CODES.NAME_REQUIRED, "Enter a name for this combo.");
  if (name.length > NAME_MAX) return refuse(CODES.NAME_REQUIRED, `Keep the combo name under ${NAME_MAX} letters.`);

  const kind = text(input.kind).toUpperCase();
  if (!COMBO_KINDS.includes(kind)) {
    return refuse(CODES.KIND_INVALID, "Choose where this combo is sold: Combo/Offer, The Cutting, Juice or Gifting.");
  }
  const comboType = text(input.combo_type ?? input.type).toUpperCase();
  if (!COMBO_TYPES.includes(comboType)) {
    return refuse(CODES.TYPE_INVALID, "Choose whether this combo is Fixed (set items and price) or Customised.");
  }

  let price = null;
  if (comboType === "FIXED") {
    const parsed = finiteOrNull(input.price);
    if (parsed === null || parsed <= 0 || parsed > PRICE_MAX) {
      return refuse(CODES.PRICE_INVALID, "Enter a selling price above zero for a fixed combo.");
    }
    price = roundMoney(parsed);
    if (price <= 0) return refuse(CODES.PRICE_INVALID, "Enter a selling price above zero for a fixed combo.");
  } else if (!isBlank(input.price)) {
    return refuse(CODES.PRICE_INVALID, "A customer's-choice combo has no fixed price: the counter works it out from the items, its margin and extra charge. Leave the price empty.");
  }

  const rawItems = input.items === undefined || input.items === null ? [] : input.items;
  if (!Array.isArray(rawItems)) return refuse(CODES.ITEM_INVALID, "Enter the combo's items as a list.");
  if (comboType === "CUSTOM" && rawItems.length > 0) {
    return refuse(CODES.ITEM_INVALID, "A customised combo has no fixed items: the cashier adds them at the counter. Remove the items, or make it a fixed combo.");
  }
  if (comboType === "FIXED" && rawItems.length === 0) {
    return refuse(CODES.ITEMS_REQUIRED, "Add at least one product to a fixed combo.");
  }
  const items = [];
  const seen = new Set();
  for (const [index, raw] of rawItems.entries()) {
    const productRef = idKey(raw?.product_id ?? raw?.product_global_id);
    const quantity = finiteOrNull(raw?.quantity);
    if (!productRef) return refuse(CODES.ITEM_INVALID, "Every combo item needs a product.");
    if (quantity === null || quantity <= 0 || toThousandths(quantity) <= 0) {
      return refuse(CODES.ITEM_INVALID, "Every combo item needs a quantity above zero.");
    }
    if (seen.has(productRef)) return refuse(CODES.ITEM_INVALID, "A product appears twice in this combo. Put it once, with the total quantity.");
    seen.add(productRef);
    const sortOrder = finiteOrNull(raw?.sort_order);
    items.push({
      product_ref: productRef,
      quantity: toThousandths(quantity) / QUANTITY_SCALE,
      sort_order: sortOrder !== null && Number.isInteger(sortOrder) ? sortOrder : index,
    });
  }

  // The extra charge per combo (making, basket): CUSTOM only, >= 0, blank meaning none. A FIXED
  // combo's price already covers it, so there it must be blank or 0.
  let extraCharge = 0;
  if (!isBlank(input.extra_charge)) {
    const parsed = finiteOrNull(input.extra_charge);
    if (parsed === null || parsed < 0 || parsed > PRICE_MAX) {
      return refuse(CODES.CHARGE_INVALID, "Enter the extra charge as an amount of zero or more, or leave it empty.");
    }
    extraCharge = roundMoney(parsed);
    if (comboType !== "CUSTOM" && extraCharge !== 0) {
      return refuse(CODES.CHARGE_INVALID, "Only a customised combo carries an extra charge. A fixed combo's price already covers it.");
    }
  }

  // The combo's own margin %, 0..1000, blank meaning "not set". FIXED: what the price suggestion
  // is worked from (unset falls back to the Sale Rate settings' margin). CUSTOM: the extra % on
  // top of the items' sale rates (unset = 0). The server stores it and never prices from it.
  let marginPercent = null;
  if (!isBlank(input.margin_percent)) {
    const parsed = finiteOrNull(input.margin_percent);
    if (parsed === null || parsed < 0 || parsed > MARGIN_MAX) {
      return refuse(CODES.MARGIN_INVALID, `Enter the margin as a percentage from 0 to ${MARGIN_MAX}, or leave it empty.`);
    }
    marginPercent = roundMoney(parsed);
  }

  const description = text(input.description);
  if (description.length > DESCRIPTION_MAX) {
    return refuse(CODES.NAME_REQUIRED, `Keep the description under ${DESCRIPTION_MAX} letters.`);
  }
  const sortOrder = finiteOrNull(input.sort_order);
  return {
    ok: true,
    value: {
      name,
      kind,
      combo_type: comboType,
      price,
      extra_charge: extraCharge,
      margin_percent: marginPercent,
      description: description || null,
      active: input.active !== false,
      sort_order: sortOrder !== null && Number.isInteger(sortOrder) ? sortOrder : 0,
      items,
    },
  };
};

/**
 * Which products of a combo are not on sale. A FIXED combo with one cannot be sold; the Combos
 * screen flags it and the POS shows "<product> is not on sale".
 */
const unavailableProductsOf = (combo) =>
  (Array.isArray(combo?.items) ? combo.items : [])
    .filter((item) => item && item.product_active === false)
    .map((item) => item.product_name || idKey(item.product_global_id || item.product_id));

/**
 * A combo with its items, one row per combo, in the shape every device receives -- from
 * `GET /api/v3/combos`, the `combo` sync change and the reference bootstrap alike.
 *
 * $1 company (NULL = any), $2 combo ids (NULL = all), $3 combo global ids (NULL = all).
 */
const COMBOS_WITH_ITEMS_SQL = `
  SELECT c.id, c.global_id, c.company_id, c.name, c.kind, c.combo_type, c.price, c.extra_charge, c.margin_percent,
         c.description, c.active, c.sort_order, c.entity_version, c.created_by, c.updated_by,
         c.created_at, c.updated_at,
         COALESCE((
           SELECT JSONB_AGG(JSONB_BUILD_OBJECT(
                    'product_id', ci.product_id,
                    'product_global_id', COALESCE(p.global_id, 'product-' || p.id::TEXT),
                    'product_name', p.product_name,
                    'unit', p.unit,
                    'product_active', COALESCE(p.active, TRUE),
                    'quantity', ci.quantity,
                    'sort_order', ci.sort_order
                  ) ORDER BY ci.sort_order, ci.id)
           FROM combo_items ci
           JOIN products p ON p.id = ci.product_id
           WHERE ci.combo_id = c.id
         ), '[]'::JSONB) AS items
  FROM combos c
  WHERE ($1::INTEGER IS NULL OR c.company_id IS NULL OR c.company_id = $1)
    AND ($2::INTEGER[] IS NULL OR c.id = ANY($2::INTEGER[]))
    AND ($3::TEXT[] IS NULL OR c.global_id = ANY($3::TEXT[]))
  ORDER BY c.sort_order, LOWER(c.name), c.id
`;

// ---------------------------------------------------------------------------------------------
// Sale lines
// ---------------------------------------------------------------------------------------------

/** Does a requested sale line carry any combo field? `line_index` alone does not count. */
const hasComboFields = (item) => COMBO_LINE_FIELDS.some((field) => !isBlank(item?.[field]));

/** True for a stored `sale_items` row (or a requested line) that belongs to a combo. */
const isComboLine = (row) => hasComboFields(row);

/** Does any of these stored rows or requested lines belong to a combo? */
const anyComboLine = (rows) => (Array.isArray(rows) ? rows : []).some(isComboLine);

/** A line's cart position: a whole number from 0, or null. */
const readLineIndex = (value) => {
  const number = finiteOrNull(value);
  return number !== null && Number.isInteger(number) && number >= 0 && number <= 2_147_483_647 ? number : null;
};

/**
 * A requested sale line's combo fields, read leniently -- they are recorded as billed, and the
 * group check below is where anything odd about them is reported -- or null for a plain line.
 */
const readSaleLineCombo = (item) => {
  if (!hasComboFields(item)) return null;
  const comboQty = finiteOrNull(item.combo_qty);
  const comboPrice = finiteOrNull(item.combo_price);
  return {
    comboLineKey: text(item.combo_line_key).slice(0, 80),
    comboId: text(item.combo_id).slice(0, 80),
    comboName: text(item.combo_name).slice(0, 120) || null,
    comboKind: text(item.combo_kind).toUpperCase().slice(0, 20) || null,
    comboType: text(item.combo_type).toUpperCase().slice(0, 10) || null,
    comboQty: comboQty !== null && comboQty > 0 && comboQty < 100_000_000_000 ? toThousandths(comboQty) / QUANTITY_SCALE : null,
    comboPrice: comboPrice !== null && comboPrice >= 0 && comboPrice < 1_000_000_000_000 ? roundMoney(comboPrice) : null,
  };
};

/**
 * A combo's line, FIXED or CUSTOM, as `buildSalePayload` parses it: priced by the offer (its share
 * of `combo_price x combo_qty`), so exempt from the per-line price rules -- rate-override
 * permission, zero-rate refusal, below-cost, the manual-discount 5%, lot discounts, the bill-slab
 * base and the duplicate product+lot rule. What it billed is checked as a group instead.
 */
const isComboPricedLine = (parsedItem) => Boolean(parsedItem?.combo);

/** The eight `sale_items` values for an invoice item, in `SALE_ITEM_COMBO_COLUMNS` order. */
const saleItemComboValues = (item) => {
  const combo = item?.combo || null;
  return [
    combo ? combo.comboLineKey || null : null,
    combo ? combo.comboId || null : null,
    combo ? combo.comboName : null,
    combo ? combo.comboKind : null,
    combo ? combo.comboType : null,
    combo ? combo.comboQty : null,
    combo ? combo.comboPrice : null,
    item?.lineIndex ?? null,
  ];
};

/** The combo fields of an invoice item as a response or sync payload spells them. */
const comboFieldsOf = (item) => {
  const [comboLineKey, comboId, comboName, comboKind, comboType, comboQty, comboPrice, lineIndex] = saleItemComboValues(item);
  return {
    combo_line_key: comboLineKey,
    combo_id: comboId,
    combo_name: comboName,
    combo_kind: comboKind,
    combo_type: comboType,
    combo_qty: comboQty,
    combo_price: comboPrice,
    line_index: lineIndex,
  };
};

// ---------------------------------------------------------------------------------------------
// Allocation: a combo's price spread over its lines
// ---------------------------------------------------------------------------------------------

/**
 * Spread `total` (= round2(combo_price x combo_qty)) over one combo instance's lines -- FIXED and
 * CUSTOM alike, so the sale lines
 * the server re-derives (`amount = round2(qty x rate)`, `net = amount - discount`) add up to the
 * offer exactly. Mirrored in `frontend/src/local/combos.js`; the two must agree to the paisa or the
 * server's "payments must equal the total" check refuses the bill.
 *
 * Worked in whole paise and thousandths (BigInt for the weights), never floats:
 * - weight_i = qty_i x saleRate_i; when every weight is 0, qty_i is the weight.
 * - share_i  = total x weight_i / sum, half up on the exact fraction, for all but the last line;
 *   the last takes the rest (a negative share is refused).
 * - rate_i   = ceil to the paisa (share_i / qty_i); amount_i = half up (qty_i x rate_i);
 *   discount_i = amount_i - share_i, the sub-paisa rounding left over (0 <= d < qty_i paise + 1).
 *   net_i = amount_i - discount_i = share_i, so the nets add up to the total exactly.
 *
 * @param {{quantity: number|string, rate: number|string}[]} lines  rate = the product's sale rate
 * @param {number|string} total
 * @returns {{ok: true, total: number, lines: object[]} | {ok: false, code: string, message: string}}
 */
const allocateFixedComboLines = (lines, total) => {
  const list = Array.isArray(lines) ? lines : [];
  const totalPaise = toPaise(total);
  if (list.length === 0) return refuse(CODES.ALLOCATION_INVALID, "A combo needs at least one line.");
  if (totalPaise === null || totalPaise < 0) return refuse(CODES.ALLOCATION_INVALID, "A combo needs a price.");
  const quantities = list.map((line) => toThousandthsExact(line?.quantity));
  if (quantities.some((quantity) => quantity === null || quantity <= 0)) {
    return refuse(CODES.ALLOCATION_INVALID, "Every combo line needs a quantity above zero.");
  }
  const rates = list.map((line) => {
    const paise = toPaise(line?.rate);
    return paise !== null && paise > 0 ? paise : 0;
  });
  // Whole paise x whole thousandths, in BigInt, so no weight or share is ever a float.
  let weights = quantities.map((quantity, index) => BigInt(quantity) * BigInt(rates[index]));
  let weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  if (weightSum === 0n) {
    weights = quantities.map((quantity) => BigInt(quantity));
    weightSum = weights.reduce((sum, weight) => sum + weight, 0n);
  }
  const bigTotal = BigInt(totalPaise);
  const shares = [];
  let allocated = 0;
  for (let index = 0; index < list.length - 1; index += 1) {
    // Half up on the exact fraction: floor((2.T.w + W) / 2W).
    const share = Number((2n * bigTotal * weights[index] + weightSum) / (2n * weightSum));
    shares.push(share);
    allocated += share;
  }
  shares.push(totalPaise - allocated);
  if (shares.some((share) => share < 0)) {
    return refuse(CODES.ALLOCATION_INVALID, "This combo's price cannot be spread over its items.");
  }

  const out = list.map((line, index) => {
    const share = shares[index];
    const quantity = quantities[index];
    const ratePaise = Math.floor((share * 1000 + quantity - 1) / quantity); // ceil(share / qty)
    const amountPaise = Math.floor((quantity * ratePaise * 2 + 1000) / 2000); // half up (qty x rate)
    return {
      ...line,
      share: share / 100,
      selling_rate: ratePaise / 100,
      amount: amountPaise / 100,
      discount_amount: (amountPaise - share) / 100,
      net_amount: share / 100,
    };
  });
  const netPaise = shares.reduce((sum, share) => sum + share, 0);
  if (netPaise !== totalPaise) {
    return refuse(CODES.ALLOCATION_INVALID, "This combo's price cannot be spread over its items.");
  }
  return { ok: true, total: totalPaise / 100, lines: out };
};

/**
 * A combo line's amount as the allocation computed it: qty x rate, half up on the exact product in
 * paise x thousandths. `roundCurrency(qty * rate)` is a float and disagrees on an exact half paisa
 * (1.7 x 39.25 = 66.725 is 66.72499... as a double, so it rounds to 66.72 where the allocation said
 * 66.73), which would leave the line a paisa short of its share and the bill a paisa off its
 * payments. The server prices a combo line with this; a plain line keeps `roundCurrency`.
 */
const comboLineAmount = (quantity, rate) => {
  const thousandths = toThousandthsExact(quantity);
  const paise = toPaise(rate);
  if (thousandths === null || paise === null) return roundMoney(Number(quantity) * Number(rate));
  const product = thousandths * paise;
  return (Math.sign(product) * Math.floor((Math.abs(product) * 2 + 1000) / 2000)) / 100;
};

// ---------------------------------------------------------------------------------------------
// The group check: what a recorded bill's combos are compared against
// ---------------------------------------------------------------------------------------------

const masterItemsByProduct = (master) => {
  const map = new Map();
  for (const item of Array.isArray(master?.items) ? master.items : []) {
    map.set(idKey(item.product_id), Number(item.quantity));
  }
  return map;
};

/**
 * Every combo on a bill, checked line group by line group. Nothing here refuses: a desktop bill
 * was already handed to the customer, so a combo that does not match is recorded as billed and
 * reported (COMBO_MISMATCH_ACCEPTED), and one the server has never heard of likewise
 * (COMBO_UNKNOWN_ACCEPTED). The caller writes each finding to the bill's audit trail.
 *
 * @param {object[]} items  invoice items: `{ combo, productId, quantity, netAmount }`
 * @param {Map<string, object>} masters  combo rows (with `items`) by global id
 * @returns {{groups: number, findings: object[]}}
 */
const checkComboGroups = (items, masters = new Map()) => {
  const groups = new Map();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.combo) continue;
    const key = item.combo.comboLineKey || "";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  const findings = [];
  for (const [key, lines] of groups) {
    const combo = lines[0].combo;
    const reasons = [];
    if (!key) reasons.push("LINE_KEY_MISSING");
    const signature = (entry) => JSON.stringify([
      entry.combo.comboId, entry.combo.comboName, entry.combo.comboKind,
      entry.combo.comboType, entry.combo.comboQty, entry.combo.comboPrice,
    ]);
    if (lines.some((line) => signature(line) !== signature(lines[0]))) reasons.push("LINES_DISAGREE");
    if (!COMBO_TYPES.includes(combo.comboType)) reasons.push("TYPE_INVALID");
    if (combo.comboQty === null || !Number.isInteger(combo.comboQty) || combo.comboQty < 1) reasons.push("QTY_INVALID");
    // A customised combo is made up once at the counter: its quantity is always 1.
    else if (combo.comboType === "CUSTOM" && combo.comboQty !== 1) reasons.push("QTY_INVALID");

    // Both types: the lines must add up to the price on the bill, within a paisa.
    const billedTotal = roundMoney(lines.reduce((sum, line) => sum + Number(line.netAmount || 0), 0));
    let expectedTotal = null;
    if (combo.comboPrice === null || combo.comboQty === null) {
      reasons.push("PRICE_MISSING");
    } else {
      expectedTotal = roundMoney(combo.comboPrice * combo.comboQty);
      if (Math.abs(cents(billedTotal) - cents(expectedTotal)) > 1) reasons.push("TOTAL_MISMATCH");
    }

    const master = combo.comboId ? masters.get(combo.comboId) : undefined;
    if (master) {
      if (master.active === false) reasons.push("COMBO_INACTIVE");
      if (String(master.combo_type || "").toUpperCase() !== combo.comboType) reasons.push("TYPE_CHANGED");
      if (combo.comboType === "FIXED" && String(master.combo_type || "").toUpperCase() === "FIXED") {
        if (finiteOrNull(master.price) === null || roundMoney(master.price) !== combo.comboPrice) reasons.push("PRICE_CHANGED");
        if (combo.comboQty !== null) {
          const expected = masterItemsByProduct(master);
          const billed = new Map();
          for (const line of lines) {
            const product = idKey(line.productId);
            billed.set(product, (billed.get(product) || 0) + (toThousandths(line.quantity) || 0));
          }
          const sameProducts = expected.size === billed.size && [...expected.keys()].every((product) => billed.has(product));
          const sameQuantities = sameProducts && [...expected].every(([product, perCombo]) =>
            billed.get(product) === Math.round(perCombo * combo.comboQty * QUANTITY_SCALE));
          if (!sameQuantities) reasons.push("ITEMS_CHANGED");
        }
      }
    }

    if (!master || reasons.length > 0) {
      findings.push({
        code: master ? CODES.MISMATCH_ACCEPTED : CODES.UNKNOWN_ACCEPTED,
        combo_line_key: key || null,
        combo_id: combo.comboId || null,
        combo_name: combo.comboName,
        reasons: master ? reasons : ["COMBO_UNKNOWN", ...reasons],
        billed: {
          combo_type: combo.comboType,
          combo_qty: combo.comboQty,
          combo_price: combo.comboPrice,
          expected_total: expectedTotal,
          total: billedTotal,
          lines: lines.map((line) => ({
            product_id: line.productId ?? null,
            quantity: line.quantity ?? null,
            net_amount: line.netAmount ?? null,
          })),
        },
        master: master
          ? {
            active: master.active !== false,
            combo_type: master.combo_type || null,
            price: master.price ?? null,
            extra_charge: master.extra_charge ?? null,
            items: (Array.isArray(master.items) ? master.items : []).map((item) => ({
              product_id: item.product_id, quantity: item.quantity,
            })),
          }
          : null,
      });
    }
  }
  return { groups: groups.size, findings };
};

module.exports = {
  CODES,
  COMBO_KINDS,
  COMBO_LINE_FIELDS,
  COMBO_TYPES,
  COMBOS_WITH_ITEMS_SQL,
  MESSAGES,
  SALE_ITEM_COMBO_COLUMNS,
  allocateFixedComboLines,
  anyComboLine,
  checkComboGroups,
  comboLineAmount,
  comboFieldsOf,
  hasComboFields,
  isComboLine,
  isComboPricedLine,
  readLineIndex,
  readSaleLineCombo,
  roundMoney,
  saleItemComboValues,
  unavailableProductsOf,
  validateComboInput,
};
