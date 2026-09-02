/**
 * Other charges on a bill: crate charge, labour charge, delivery charge, anything else.
 *
 * The maintainer's rules, settled in conversation and pinned by `otherCharges.test.mjs`:
 *
 *   1. A charge is a charge, not a deposit. Money taken is money kept; nothing is owed back when a
 *      crate returns. (If that ever changes it is a different feature -- a liability per customer --
 *      and not a bigger version of this one.)
 *   2. Mandi Tax does not apply to charges. Tax is on fruit. Charges are added after tax, so they
 *      never enter the taxable amount.
 *   3. A slab rounds **up**. With 10 km at 100 and 15 km at 150, a 12 km delivery costs 150 --
 *      because 12 km is past what 100 was meant to cover.
 *
 * ## The rule that matters most
 *
 * A measurement past the last slab has **no rate**, and that is reported as its own state. It is
 * never quietly charged at the top slab's price, and never at zero.
 *
 * With slabs at 10 km and 15 km, a 40 km delivery is not a 150 rupee delivery -- nobody wrote a
 * price for 40 km, and charging the top slab silently loses money on exactly the trips where the
 * loss is largest. `Products: 0` next to a non-zero stock value is a bug rather than an empty
 * result, and so is `Delivery: 150` for a distance nobody priced. The POS is expected to show the
 * refusal and let the shop enter a price by hand or add a slab.
 */

const numberValue = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** Money rounds to 2 decimals; the EPSILON nudge keeps 1.005 from rounding down. */
const roundMoney = (value) => Math.round((numberValue(value) + Number.EPSILON) * 100) / 100;

/** Quantities carry 3 decimals. */
const roundQuantity = (value) => Math.round((numberValue(value) + Number.EPSILON) * 1000) / 1000;

const cleanText = (value) => String(value ?? "").trim();

/** How a charge decides its rate. */
export const CHARGE_BASIS = Object.freeze({
  /** One price, however much there is of it. A flat labour charge. */
  FLAT: "FLAT",
  /** Price depends on a measurement -- crate size in kg, delivery distance in km. */
  SLAB: "SLAB",
});

/** Why a charge could not price itself. Each is a state the POS must show, never swallow. */
export const CHARGE_REFUSALS = Object.freeze({
  /** The charge is measured, and nobody said how much of it there is. */
  MEASUREMENT_REQUIRED: "MEASUREMENT_REQUIRED",
  /** The measurement is past the largest slab. Nobody wrote a price for this. */
  ABOVE_TOP_SLAB: "ABOVE_TOP_SLAB",
  /** The charge is measured and has no slabs at all. */
  NO_SLABS: "NO_SLABS",
  /** A flat charge whose rate was never set. */
  NO_RATE: "NO_RATE",
});

/**
 * Slabs, cleaned and ordered smallest first.
 *
 * A slab is `{ upto, rate }`: "up to and including this measurement, charge this". Rows without a
 * usable threshold are dropped rather than sorted to an arbitrary place, because a slab with no
 * threshold cannot be matched by any measurement and would only make the ordering unpredictable.
 */
export const normaliseSlabs = (slabs) => (Array.isArray(slabs) ? slabs : [])
  .filter((slab) => slab && slab.active !== false)
  .map((slab) => ({
    upto: Number(slab.upto ?? slab.upto_value ?? slab.threshold),
    // Not `??`: a genuinely free slab has rate 0, and `??` would let `0` through while `||` would
    // not -- but an absent rate must be caught, so the check is explicit.
    rate: Number(slab.rate ?? slab.charge_rate),
    label: cleanText(slab.label),
  }))
  .filter((slab) => Number.isFinite(slab.upto) && slab.upto > 0 && Number.isFinite(slab.rate) && slab.rate >= 0)
  .sort((first, second) => first.upto - second.upto);

/**
 * The rate for one charge at one measurement.
 *
 * @returns {{ok: true, rate: number, slab: object|null}|{ok: false, code: string, message: string}}
 */
export const resolveChargeRate = (chargeType, measurement) => {
  const basis = cleanText(chargeType?.basis || chargeType?.charge_basis).toUpperCase() === CHARGE_BASIS.SLAB
    ? CHARGE_BASIS.SLAB
    : CHARGE_BASIS.FLAT;
  const name = cleanText(chargeType?.charge_name || chargeType?.name) || "This charge";
  const unit = cleanText(chargeType?.measure_unit || chargeType?.unit);

  if (basis === CHARGE_BASIS.FLAT) {
    const rate = Number(chargeType?.flat_rate ?? chargeType?.rate);
    if (!Number.isFinite(rate) || rate < 0) {
      return { ok: false, code: CHARGE_REFUSALS.NO_RATE, message: `${name} has no rate set.` };
    }
    return { ok: true, rate: roundMoney(rate), slab: null };
  }

  const slabs = normaliseSlabs(chargeType?.slabs);
  if (!slabs.length) {
    return {
      ok: false,
      code: CHARGE_REFUSALS.NO_SLABS,
      message: `${name} is priced by ${unit || "measurement"}, but no rates have been set for it.`,
    };
  }

  const value = Number(measurement);
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      code: CHARGE_REFUSALS.MEASUREMENT_REQUIRED,
      message: `Enter the ${unit || "measurement"} for ${name}.`,
    };
  }

  // Round up: the first slab that covers this measurement. 12 km is past the 10 km slab, so it is
  // priced at 15 km.
  const slab = slabs.find((candidate) => value <= candidate.upto);
  if (!slab) {
    const top = slabs[slabs.length - 1];
    return {
      ok: false,
      code: CHARGE_REFUSALS.ABOVE_TOP_SLAB,
      // Says the number, because "no rate" without it sends somebody hunting through settings.
      message: `${name} has rates up to ${top.upto} ${unit || ""}`.trim()
        + `, and this is ${value}. Add a slab, or enter the amount by hand.`,
    };
  }
  return { ok: true, rate: roundMoney(slab.rate), slab };
};

/**
 * One priced line on the bill.
 *
 * `quantity` is how many times the charge applies -- four crates, one delivery. `measurement` is
 * what decides the rate -- a 10 kg crate, a 12 km trip. They are different numbers and conflating
 * them prices four crates as a 4 kg crate.
 */
export const buildChargeLine = (chargeType, { measurement, quantity = 1, manualAmount } = {}) => {
  const name = cleanText(chargeType?.charge_name || chargeType?.name);
  const countedQuantity = roundQuantity(Number.isFinite(Number(quantity)) ? Number(quantity) : 1);

  if (countedQuantity <= 0) {
    return { ok: false, code: CHARGE_REFUSALS.MEASUREMENT_REQUIRED, message: `How many ${name || "charges"}?` };
  }

  // A hand-entered amount overrides the slabs, which is how a shop prices the trip nobody wrote a
  // rate for. Recorded as manual so a bill can say where its number came from.
  const typed = Number(manualAmount);
  if (cleanText(manualAmount) !== "" && Number.isFinite(typed) && typed >= 0) {
    return {
      ok: true,
      line: {
        charge_type_id: chargeType?.id ?? null,
        charge_name: name,
        basis: CHARGE_BASIS.FLAT,
        measure_unit: cleanText(chargeType?.measure_unit || chargeType?.unit),
        measurement: Number.isFinite(Number(measurement)) ? Number(measurement) : null,
        quantity: countedQuantity,
        rate: roundMoney(typed),
        amount: roundMoney(typed * countedQuantity),
        manual: true,
        slab_upto: null,
      },
    };
  }

  const resolved = resolveChargeRate(chargeType, measurement);
  if (!resolved.ok) return resolved;

  return {
    ok: true,
    line: {
      charge_type_id: chargeType?.id ?? null,
      charge_name: name,
      basis: resolved.slab ? CHARGE_BASIS.SLAB : CHARGE_BASIS.FLAT,
      measure_unit: cleanText(chargeType?.measure_unit || chargeType?.unit),
      measurement: resolved.slab ? Number(measurement) : null,
      quantity: countedQuantity,
      rate: resolved.rate,
      amount: roundMoney(resolved.rate * countedQuantity),
      manual: false,
      slab_upto: resolved.slab ? resolved.slab.upto : null,
    },
  };
};

/** What the charges add up to. Rounded once at the end, not per line and again in the sum. */
export const totalCharges = (lines) => roundMoney(
  (Array.isArray(lines) ? lines : []).reduce((sum, line) => sum + numberValue(line?.amount), 0)
);

/**
 * Fold charges into a bill's totals.
 *
 * Charges land **after** tax and are absent from `taxableAmount`, which is rule 2. Passing them
 * through the taxable amount instead would silently raise Mandi Tax on every bill carrying a
 * delivery -- money the shop would owe and had not collected.
 *
 * The input totals are returned untouched apart from the two fields that must move, so a caller
 * cannot accidentally lose a discount by routing it through here.
 */
export const applyChargesToTotals = (totals, lines) => {
  const charges = totalCharges(lines);
  const taxableAmount = roundMoney(totals?.taxableAmount ?? totals?.taxable_amount);
  const taxAmount = roundMoney(totals?.taxAmount ?? totals?.tax_amount);
  const netBeforeCharges = roundMoney(
    Number.isFinite(Number(totals?.netAmount ?? totals?.net_amount))
      ? Number(totals?.netAmount ?? totals?.net_amount)
      : taxableAmount + taxAmount
  );

  return {
    ...totals,
    taxableAmount,
    taxAmount,
    otherChargesAmount: charges,
    netBeforeCharges,
    totalAmount: roundMoney(netBeforeCharges + charges),
  };
};

/**
 * Everything a POS needs for the charges panel in one pass: the priced lines, the ones that could
 * not price themselves, and the total.
 *
 * Refusals are returned rather than thrown, and they are returned *alongside* the lines that did
 * work, because a bill with one unpriceable delivery still has three priceable crates and the
 * cashier needs to see both halves at once.
 */
export const buildChargesForBill = (chargeTypes, selections) => {
  const byId = new Map((Array.isArray(chargeTypes) ? chargeTypes : []).map((type) => [String(type?.id), type]));
  const lines = [];
  const refusals = [];

  for (const selection of Array.isArray(selections) ? selections : []) {
    const chargeType = byId.get(String(selection?.charge_type_id ?? selection?.id));
    if (!chargeType) {
      refusals.push({
        charge_type_id: selection?.charge_type_id ?? selection?.id ?? null,
        code: CHARGE_REFUSALS.NO_RATE,
        message: "This charge is no longer set up. Remove it from the bill, or add it back in Settings.",
      });
      continue;
    }
    if (chargeType.active === false) {
      refusals.push({
        charge_type_id: chargeType.id,
        code: CHARGE_REFUSALS.NO_RATE,
        message: `${cleanText(chargeType.charge_name || chargeType.name)} has been turned off.`,
      });
      continue;
    }
    const built = buildChargeLine(chargeType, selection);
    if (built.ok) lines.push(built.line);
    else refusals.push({ charge_type_id: chargeType.id, code: built.code, message: built.message });
  }

  return { lines, refusals, otherChargesAmount: totalCharges(lines) };
};
