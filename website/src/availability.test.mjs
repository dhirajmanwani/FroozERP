import test from "node:test";
import assert from "node:assert/strict";

import {
  AVAILABILITY,
  CLAMP_REASON,
  DEFAULT_LOW_STOCK_KG,
  canOrder,
  clampToAvailable,
  describeFreshness,
  resolveAvailability,
} from "./availability.js";

const product = (overrides = {}) => ({
  productId: "004",
  name: "Alphonso mango",
  ratePerKg: 480,
  availableKg: 12.5,
  ...overrides,
});

/**
 * Timestamps are written with an explicit +05:30 offset and compared against an explicit `nowMs`,
 * so every expectation here holds whatever timezone the machine running the tests is set to. A
 * suite in this repo has already had to be fixed once for depending on the host's clock settings.
 */
const IST_MORNING = Date.parse("2026-08-22T07:00:00+05:30");

test("a healthy quantity is in stock and reports the kilos it saw", () => {
  const result = resolveAvailability(product({ availableKg: 12.5 }));
  assert.equal(result.state, AVAILABILITY.IN_STOCK);
  assert.equal(result.availableKg, 12.5);
  assert.equal(result.limited, false);
});

test("a quantity at or below the low-stock threshold is limited, not merely in stock", () => {
  assert.equal(resolveAvailability(product({ availableKg: DEFAULT_LOW_STOCK_KG })).state, AVAILABILITY.LIMITED);
  assert.equal(resolveAvailability(product({ availableKg: 0.25 })).state, AVAILABILITY.LIMITED);
  assert.equal(resolveAvailability(product({ availableKg: DEFAULT_LOW_STOCK_KG + 0.001 })).state, AVAILABILITY.IN_STOCK);
  assert.equal(resolveAvailability(product({ availableKg: 0.25 })).limited, true);
});

test("the low-stock threshold can be raised for a product that sells in bulk", () => {
  const result = resolveAvailability(product({ availableKg: 12.5 }), { lowStockKg: 20 });
  assert.equal(result.state, AVAILABILITY.LIMITED);
  assert.equal(result.availableKg, 12.5);
});

test("a zero quantity is genuinely sold out and is never reported as unknown", () => {
  // This is the case a `??` or `||` chain gets wrong: zero is a real, measured answer and must not
  // fall through to a fallback or to "we could not check".
  for (const quantity of [0, "0", 0.0, "0.000"]) {
    const result = resolveAvailability(product({ availableKg: quantity }));
    assert.equal(result.state, AVAILABILITY.SOLD_OUT, `${JSON.stringify(quantity)} is a measured zero`);
    assert.equal(result.availableKg, 0);
  }
});

test("a quantity we could not read is unknown and never collapses into sold out", () => {
  const unusable = [
    ["the field is missing entirely", {}],
    ["the field is null", { availableKg: null }],
    ["the field is undefined", { availableKg: undefined }],
    ["the field is NaN", { availableKg: Number.NaN }],
    ["the field is Infinity", { availableKg: Number.POSITIVE_INFINITY }],
    ["the field is negative Infinity", { availableKg: Number.NEGATIVE_INFINITY }],
    ["the field is negative", { availableKg: -3 }],
    ["the field is a negative string", { availableKg: "-0.5" }],
    ["the field is a blank string", { availableKg: "   " }],
    ["the field is not a number at all", { availableKg: "unknown" }],
    ["the field is a boolean", { availableKg: true }],
    ["the row itself is marked stale", { availableKg: 9, stockKnown: false }],
  ];
  for (const [why, overrides] of unusable) {
    const base = { ...product(), ...overrides };
    if (!("availableKg" in overrides) || base.availableKg === undefined) delete base.availableKg;
    const result = resolveAvailability(base);
    assert.equal(result.state, AVAILABILITY.UNKNOWN, why);
    assert.notEqual(result.state, AVAILABILITY.SOLD_OUT, why);
    assert.equal(result.availableKg, null, `${why}: availableKg must be null, never 0`);
  }
});

test("an explicit load failure is unknown whatever the cached product happens to say", () => {
  const stale = product({ availableKg: 40 });
  for (const options of [{ loadFailed: true }, { stockKnown: false }]) {
    const result = resolveAvailability(stale, options);
    assert.equal(result.state, AVAILABILITY.UNKNOWN);
    assert.equal(result.availableKg, null);
  }
  assert.equal(resolveAvailability(null).state, AVAILABILITY.UNKNOWN);
  assert.equal(resolveAvailability(undefined).availableKg, null);
});

test("the unknown message admits we could not check and points at the shop", () => {
  const message = resolveAvailability(product({ availableKg: null })).message;
  assert.match(message, /could not check/i);
  assert.match(message, /shop/i);
  // It must never read as a refusal: the fruit may well be sitting in the crate.
  assert.doesNotMatch(message, /sold out|out of stock|unavailable|not available/i);
});

test("the sold out message says it plainly and offers a next step", () => {
  const message = resolveAvailability(product({ availableKg: 0 })).message;
  assert.match(message, /sold out/i);
  assert.match(message, /shop/i);
});

test("the snapshot's aliased quantity columns are all read", () => {
  // remaining_qty and balance_qty come out of one column in local_db.rs, so whichever one the feed
  // carries has to work.
  for (const field of ["available_kg", "available_qty", "balance_qty", "remaining_qty", "current_stock"]) {
    const result = resolveAvailability({ productId: "004", [field]: 7.5 });
    assert.equal(result.state, AVAILABILITY.IN_STOCK, field);
    assert.equal(result.availableKg, 7.5, field);
  }
});

test("only stock we have actually seen may be ordered", () => {
  assert.equal(canOrder(AVAILABILITY.IN_STOCK), true);
  assert.equal(canOrder(AVAILABILITY.LIMITED), true);
  assert.equal(canOrder(AVAILABILITY.SOLD_OUT), false);
  assert.equal(canOrder(AVAILABILITY.UNKNOWN), false);
  assert.equal(canOrder(undefined), false);
});

test("clamping distinguishes nothing left from we do not know, though both give zero kilos", () => {
  const soldOut = clampToAvailable(2, resolveAvailability(product({ availableKg: 0 })));
  const unknown = clampToAvailable(2, resolveAvailability(product({ availableKg: null })));

  assert.equal(soldOut.quantityKg, 0);
  assert.equal(unknown.quantityKg, 0);
  // The quantity alone cannot tell the two apart, so the reason must, and it always carries one.
  assert.equal(soldOut.reason, CLAMP_REASON.SOLD_OUT);
  assert.equal(unknown.reason, CLAMP_REASON.UNKNOWN_STOCK);
  assert.equal(soldOut.stockKnown, true);
  assert.equal(unknown.stockKnown, false);
  assert.notEqual(soldOut.message, unknown.message);
  assert.match(unknown.message, /could not check/i);
});

test("a zero quantity from clamping never comes back with no reason attached", () => {
  for (const availability of [
    resolveAvailability(product({ availableKg: 0 })),
    resolveAvailability(product({ availableKg: null })),
    resolveAvailability(product({ availableKg: 5 })),
  ]) {
    for (const requested of [0, -1, "", "abc", null, Number.NaN, 3]) {
      const result = clampToAvailable(requested, availability);
      if (result.quantityKg === 0) {
        assert.notEqual(result.reason, CLAMP_REASON.NONE, `${availability.state} / ${String(requested)}`);
      }
    }
  }
});

test("clamping cuts a request down to the stock actually on the shelf and says so", () => {
  const availability = resolveAvailability(product({ availableKg: 1.25 }));
  const result = clampToAvailable(5, availability);
  assert.equal(result.quantityKg, 1.25);
  assert.equal(result.clamped, true);
  assert.equal(result.reason, CLAMP_REASON.LIMITED_STOCK);
  assert.match(result.message, /1\.250 kg/);
});

test("a request that fits is passed through untouched and rounded to three decimals", () => {
  const availability = resolveAvailability(product({ availableKg: 12.5 }));
  const result = clampToAvailable("2.5006", availability);
  assert.equal(result.quantityKg, 2.501);
  assert.equal(result.clamped, false);
  assert.equal(result.reason, CLAMP_REASON.NONE);
  assert.equal(result.stockKnown, true);
});

test("an unusable requested weight is called an invalid request, not a sold out product", () => {
  const availability = resolveAvailability(product({ availableKg: 12.5 }));
  for (const requested of [null, undefined, "", "  ", "abc", Number.NaN, Number.POSITIVE_INFINITY, -2, 0]) {
    const result = clampToAvailable(requested, availability);
    assert.equal(result.quantityKg, 0, String(requested));
    assert.equal(result.reason, CLAMP_REASON.INVALID_REQUEST, String(requested));
    assert.equal(result.stockKnown, true, String(requested));
  }
});

test("clamping against a missing availability record is unknown stock rather than sold out", () => {
  assert.equal(clampToAvailable(2, undefined).reason, CLAMP_REASON.UNKNOWN_STOCK);
  assert.equal(clampToAvailable(2, {}).reason, CLAMP_REASON.UNKNOWN_STOCK);
  assert.equal(clampToAvailable(2, { state: AVAILABILITY.IN_STOCK }).reason, CLAMP_REASON.UNKNOWN_STOCK);
  assert.equal(clampToAvailable(2, { state: AVAILABILITY.IN_STOCK }).stockKnown, false);
});

test("freshness returns null rather than a vague string when there is no usable arrival time", () => {
  // null, so the page leaves the line out entirely. "Freshness unknown" under a mango helps nobody.
  for (const overrides of [{}, { arrivedAt: null }, { arrivedAt: "" }, { arrivedAt: "not a date" }, { arrivedAt: Number.NaN }]) {
    assert.equal(describeFreshness({ ...product(), ...overrides }, IST_MORNING), null, JSON.stringify(overrides));
  }
  assert.equal(describeFreshness(null, IST_MORNING), null);
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-22T06:00:00+05:30" }), Number.NaN), null);
});

test("a late evening arrival reads as yesterday to a customer looking the next morning", () => {
  // Fourteen hours apart, so a raw 24-hour span would call this "today". The shop and the customer
  // both call it yesterday, because the calendar date changed.
  const arrivedAt = "2026-08-21T21:30:00+05:30";
  assert.ok(IST_MORNING - Date.parse(arrivedAt) < 24 * 60 * 60 * 1000, "the two instants are under a day apart");
  assert.equal(describeFreshness(product({ arrivedAt }), IST_MORNING), "Arrived yesterday");
});

test("an arrival earlier the same morning reads as this morning", () => {
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-22T05:45:00+05:30" }), IST_MORNING), "Arrived this morning");
});

test("an afternoon arrival on the same day reads as today rather than as this morning", () => {
  const evening = Date.parse("2026-08-22T20:00:00+05:30");
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-22T14:00:00+05:30" }), evening), "Arrived today");
});

test("older lots are counted in whole days, and anything past a week stops counting", () => {
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-19T23:50:00+05:30" }), IST_MORNING), "Arrived 3 days ago");
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-17T04:00:00+05:30" }), IST_MORNING), "Arrived 5 days ago");
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-15T04:00:00+05:30" }), IST_MORNING), "Arrived over a week ago");
});

test("an arrival dated in the future says nothing at all", () => {
  assert.equal(describeFreshness(product({ arrivedAt: "2026-08-23T08:00:00+05:30" }), IST_MORNING), null);
});

test("freshness is measured in the shop's calendar days, not the host machine's", () => {
  // 02:00 IST on the 22nd is 20:30 UTC on the 21st. In the shop's own time that is this morning;
  // told to use UTC it is yesterday. The answer moves with the shop's offset and with nothing else,
  // which is what keeps this suite honest on a CI box set to UTC.
  const arrivedAt = "2026-08-22T02:00:00+05:30";
  assert.equal(describeFreshness(product({ arrivedAt }), IST_MORNING), "Arrived this morning");
  assert.equal(
    describeFreshness(product({ arrivedAt }), IST_MORNING, { shopUtcOffsetMinutes: 0 }),
    "Arrived yesterday",
  );
});

test("the arrival timestamp is read from any of the names the feed might use", () => {
  for (const field of ["arrivedAt", "arrived_at", "arrivalAt", "arrival_date", "lot_arrival_date"]) {
    assert.equal(
      describeFreshness({ productId: "004", [field]: "2026-08-21T21:30:00+05:30" }, IST_MORNING),
      "Arrived yesterday",
      field,
    );
  }
  assert.equal(describeFreshness({ arrivedAt: new Date("2026-08-21T21:30:00+05:30") }, IST_MORNING), "Arrived yesterday");
});

test("the availability states are frozen so a page cannot rename one at runtime", () => {
  assert.throws(() => { AVAILABILITY.UNKNOWN = "SOLD_OUT"; }, TypeError);
});
