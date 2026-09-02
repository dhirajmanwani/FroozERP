import test from "node:test";
import assert from "node:assert/strict";

import {
  CHARGE_BASIS,
  CHARGE_REFUSALS,
  applyChargesToTotals,
  buildChargeLine,
  buildChargesForBill,
  normaliseSlabs,
  resolveChargeRate,
  totalCharges,
} from "./otherCharges.js";

/**
 * The three rules the maintainer settled, and the one this file mostly exists to defend.
 *
 *   1. A charge is kept, not owed back.  (Nothing here to test -- it is what is *absent*.)
 *   2. Mandi Tax does not apply to charges.
 *   3. A slab rounds up.
 *
 * The fourth rule is mine, and it is the dangerous one: a measurement past the last slab has no
 * price, and must say so. Charging the top slab for a 40 km delivery when the slabs stop at 15 km
 * loses money on precisely the trips that cost most, and it does it silently, on every bill,
 * forever. So several tests below exist for that one shape.
 */

/** Delivery: 10 km costs 100, 15 km costs 150. The maintainer's own example. */
const DELIVERY = Object.freeze({
  id: 3,
  charge_name: "Delivery charge",
  basis: CHARGE_BASIS.SLAB,
  measure_unit: "km",
  slabs: [{ upto: 15, rate: 150 }, { upto: 10, rate: 100 }],
});

/** Crate: a 10 kg crate costs 40, a 20 kg crate costs 50. Also his example. */
const CRATE = Object.freeze({
  id: 1,
  charge_name: "Crate charge",
  basis: CHARGE_BASIS.SLAB,
  measure_unit: "kg",
  slabs: [{ upto: 10, rate: 40 }, { upto: 20, rate: 50 }],
});

const LABOUR = Object.freeze({
  id: 2,
  charge_name: "Labour charge",
  basis: CHARGE_BASIS.FLAT,
  flat_rate: 30,
});

test("a slab rounds up: 12 km is priced at the 15 km rate", () => {
  // The maintainer's ruling, in his own numbers. 12 km is past what 100 was meant to cover.
  const resolved = resolveChargeRate(DELIVERY, 12);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.rate, 150);
});

test("a measurement landing exactly on a slab uses that slab, not the next one up", () => {
  // Off-by-one in the other direction: `<` instead of `<=` would charge 150 for a 10 km delivery
  // and nobody would notice until a customer argued about it.
  assert.equal(resolveChargeRate(DELIVERY, 10).rate, 100);
  assert.equal(resolveChargeRate(CRATE, 10).rate, 40);
  assert.equal(resolveChargeRate(CRATE, 20).rate, 50);
});

test("anything below the smallest slab is priced at the smallest slab", () => {
  const resolved = resolveChargeRate(DELIVERY, 2);
  assert.equal(resolved.ok, true);
  assert.equal(resolved.rate, 100, "a 2 km trip still costs the 10 km price");
});

test("a measurement past the last slab is refused by name, not priced at the top slab", () => {
  // The headline case. 40 km is not a 150-rupee delivery; nobody priced 40 km.
  const resolved = resolveChargeRate(DELIVERY, 40);
  assert.equal(resolved.ok, false);
  assert.equal(resolved.code, CHARGE_REFUSALS.ABOVE_TOP_SLAB);
  assert.equal(resolved.rate, undefined, "it must not hand back a rate at all");
  assert.match(resolved.message, /15/, "the message must say how far the rates go");
  assert.match(resolved.message, /40/, "and what was asked for");
});

test("a refused charge produces no line and no amount, rather than a zero one", () => {
  // `Delivery: 0` on a bill reads as "no delivery", which is worse than an error: the cashier hands
  // the fruit over and the trip is free.
  const built = buildChargeLine(DELIVERY, { measurement: 40 });
  assert.equal(built.ok, false);
  assert.equal(built.line, undefined);
});

test("a slab charge with no measurement asks for one", () => {
  const built = buildChargeLine(DELIVERY, {});
  assert.equal(built.code, CHARGE_REFUSALS.MEASUREMENT_REQUIRED);
  assert.match(built.message, /km/, "it must name the unit the shop uses, not a generic word");
});

test("a slab charge with no slabs set up says so instead of charging nothing", () => {
  const built = resolveChargeRate({ ...DELIVERY, slabs: [] }, 12);
  assert.equal(built.code, CHARGE_REFUSALS.NO_SLABS);
});

test("a flat charge needs no measurement, and one with no rate is refused", () => {
  assert.equal(resolveChargeRate(LABOUR, undefined).rate, 30);
  assert.equal(resolveChargeRate({ ...LABOUR, flat_rate: undefined }, 5).code, CHARGE_REFUSALS.NO_RATE);
});

test("a rate of zero is a rate, and is not mistaken for a missing one", () => {
  // `??` does not fall through on 0 but `||` does, and a free delivery inside 5 km is a real thing
  // a shop might set up.
  const free = resolveChargeRate({ ...LABOUR, flat_rate: 0 }, 1);
  assert.equal(free.ok, true);
  assert.equal(free.rate, 0);

  const freeSlab = resolveChargeRate({ ...DELIVERY, slabs: [{ upto: 5, rate: 0 }, { upto: 15, rate: 150 }] }, 3);
  assert.equal(freeSlab.ok, true);
  assert.equal(freeSlab.rate, 0);
});

test("quantity and measurement are different numbers", () => {
  // Four 10 kg crates is 4 x 40, not one 4 kg crate. Conflating them is the arithmetic mistake this
  // shape invites, and it under-charges by exactly the amount that matters.
  const built = buildChargeLine(CRATE, { measurement: 10, quantity: 4 });
  assert.equal(built.ok, true);
  assert.equal(built.line.rate, 40, "the rate comes from the crate size");
  assert.equal(built.line.quantity, 4, "the count is how many crates");
  assert.equal(built.line.amount, 160);
});

test("a hand-entered amount overrides the slabs and is recorded as manual", () => {
  // This is how a shop prices the 40 km trip today rather than after a settings change.
  const built = buildChargeLine(DELIVERY, { measurement: 40, manualAmount: 400 });
  assert.equal(built.ok, true);
  assert.equal(built.line.amount, 400);
  assert.equal(built.line.manual, true, "the bill must be able to say the number was typed, not derived");
});

test("charges never enter the taxable amount", () => {
  // Rule 2. If charges went through the taxable amount, every bill with a delivery would raise the
  // shop's Mandi Tax on money it did not collect tax on.
  const totals = applyChargesToTotals(
    { taxableAmount: 1000, taxAmount: 20, netAmount: 1020 },
    [{ amount: 150 }, { amount: 40 }],
  );
  assert.equal(totals.taxableAmount, 1000, "unchanged by charges");
  assert.equal(totals.taxAmount, 20, "unchanged by charges");
  assert.equal(totals.otherChargesAmount, 190);
  assert.equal(totals.totalAmount, 1210, "charges land after tax");
});

test("folding charges in leaves every other total alone", () => {
  // A caller must be able to route totals through here without losing a discount on the way.
  const before = {
    grossAmount: 1200,
    itemDiscountAmount: 100,
    invoiceDiscountAmount: 100,
    taxableAmount: 1000,
    taxAmount: 20,
    netAmount: 1020,
  };
  const after = applyChargesToTotals(before, [{ amount: 40 }]);
  assert.equal(after.grossAmount, 1200);
  assert.equal(after.itemDiscountAmount, 100);
  assert.equal(after.invoiceDiscountAmount, 100);
});

test("with no charges at all, the total is exactly what it was", () => {
  const after = applyChargesToTotals({ taxableAmount: 1000, taxAmount: 20, netAmount: 1020 }, []);
  assert.equal(after.otherChargesAmount, 0);
  assert.equal(after.totalAmount, 1020);
});

test("money is rounded once, at the end", () => {
  // Rounding each line and then summing drifts. 33.335 x 3 is 100.005, which must not become 100.02
  // by way of three separate roundings.
  const lines = [{ amount: 33.335 }, { amount: 33.335 }, { amount: 33.335 }];
  assert.equal(totalCharges(lines), 100.01);
});

test("slabs are ordered smallest first however they arrive", () => {
  // DELIVERY deliberately lists 15 before 10. Matching "the first slab that covers this" only works
  // on a sorted list, and settings screens hand back whatever order the database felt like.
  assert.deepEqual(normaliseSlabs(DELIVERY.slabs).map((slab) => slab.upto), [10, 15]);
});

test("slabs with no usable threshold or rate are dropped, not sorted into nowhere", () => {
  const slabs = normaliseSlabs([
    { upto: 10, rate: 40 },
    { upto: null, rate: 60 },
    { upto: 20, rate: null },
    { upto: -5, rate: 10 },
    { upto: 20, rate: 50, active: false },
    { upto: 30, rate: 70 },
  ]);
  assert.deepEqual(slabs.map((slab) => slab.upto), [10, 30]);
});

test("a bill returns its priced lines and its problems together", () => {
  // A cashier with three good crates and one unpriceable delivery needs to see both at once. An
  // all-or-nothing result would either hide the problem or hide the work.
  const result = buildChargesForBill([CRATE, DELIVERY, LABOUR], [
    { charge_type_id: 1, measurement: 10, quantity: 3 },
    { charge_type_id: 3, measurement: 40 },
    { charge_type_id: 2 },
  ]);

  assert.equal(result.lines.length, 2);
  assert.equal(result.otherChargesAmount, 150, "3 crates at 40, plus 30 labour");
  assert.equal(result.refusals.length, 1);
  assert.equal(result.refusals[0].code, CHARGE_REFUSALS.ABOVE_TOP_SLAB);
});

test("a charge that was deleted or switched off is refused rather than silently dropped", () => {
  // Silently dropping it would quietly reduce the bill, which looks like the price simply changed.
  const deleted = buildChargesForBill([CRATE], [{ charge_type_id: 999 }]);
  assert.equal(deleted.lines.length, 0);
  assert.equal(deleted.refusals.length, 1);

  const off = buildChargesForBill([{ ...CRATE, active: false }], [{ charge_type_id: 1, measurement: 10 }]);
  assert.equal(off.lines.length, 0);
  assert.equal(off.refusals.length, 1);
  assert.match(off.refusals[0].message, /turned off/);
});

test("any charge the shop invents works the same way, with its own unit", () => {
  // Nothing here knows what a crate or a kilometre is. The maintainer adds charges himself, names
  // them, and names the unit -- so a hardcoded list of three would be exactly wrong.
  const cold = {
    id: 77,
    charge_name: "Cold storage",
    basis: CHARGE_BASIS.SLAB,
    measure_unit: "days",
    slabs: [{ upto: 3, rate: 25 }, { upto: 7, rate: 50 }],
  };
  const built = buildChargeLine(cold, { measurement: 5, quantity: 2 });
  assert.equal(built.line.rate, 50);
  assert.equal(built.line.amount, 100);
  assert.equal(built.line.measure_unit, "days");

  const past = resolveChargeRate(cold, 30);
  assert.match(past.message, /days/, "the refusal speaks the shop's own unit back to it");
});
