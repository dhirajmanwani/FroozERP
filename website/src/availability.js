/**
 * What one product's stock really is, said honestly.
 *
 * The design brief's rule for the site is "stock is the honest part": never show an item as
 * available when it is not, and **never show `0` where the truth is "we could not check"**. That is
 * the same rule as CLAUDE.md's "errors must never render as zero", and it is the entire reason this
 * module exists rather than the page reading `product.available_kg` inline.
 *
 * So there are four states, not three. `UNKNOWN` is the one that earns its keep: a feed that omitted
 * the field, a field that is not a finite number, a negative quantity, or a load that failed
 * outright all mean *we do not know*, and none of them may collapse into `SOLD_OUT`. Telling a
 * customer an item is sold out when it is sitting in a crate loses the sale; telling them it is
 * available when it is not loses the customer. `UNKNOWN` says the true thing and hands them a way
 * to find out — the shop's phone.
 *
 * Everything here is pure and takes an explicit `nowMs`, because the freshness line compares
 * calendar days and a test that leans on the host clock is a test that fails on somebody else's
 * laptop. That has already happened once in this repo.
 */

/** The four states a product's stock can be in on the site. */
export const AVAILABILITY = Object.freeze({
  IN_STOCK: "IN_STOCK",
  LIMITED: "LIMITED",
  SOLD_OUT: "SOLD_OUT",
  UNKNOWN: "UNKNOWN",
});

/**
 * At or below this many kilos, a product is "limited" rather than plainly in stock.
 * Five kilos of produce is a morning's selling, so it is worth telling the customer to hurry.
 */
export const DEFAULT_LOW_STOCK_KG = 5;

/**
 * The shop is in India and India has no daylight saving, so a fixed +05:30 offset is exact and
 * needs no timezone database. It is deliberately *not* the host's timezone: a customer in another
 * zone, or a CI box running in UTC, must still be told what "yesterday" means to the shop.
 */
export const SHOP_UTC_OFFSET_MINUTES = 330;

/** Why `clampToAvailable` gave back the quantity it did. Always set — see the note on the function. */
export const CLAMP_REASON = Object.freeze({
  /** The full requested quantity is orderable. */
  NONE: "NONE",
  /** The request was cut down to the stock actually on the shelf. */
  LIMITED_STOCK: "LIMITED_STOCK",
  /** There is genuinely nothing left. Zero because zero is the truth. */
  SOLD_OUT: "SOLD_OUT",
  /** We could not read the stock at all. Zero because we refuse to guess, NOT because it is empty. */
  UNKNOWN_STOCK: "UNKNOWN_STOCK",
  /** The requested quantity itself was unusable — blank, negative, not a number. */
  INVALID_REQUEST: "INVALID_REQUEST",
});

const QUANTITY_DECIMALS = 3;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * A number we are willing to believe, or `null`.
 *
 * Numeric strings are accepted because feeds hand them over routinely — `pg` returns NUMERIC
 * columns as strings — but `""`, whitespace, booleans and arrays are refused, because `Number("")`
 * is `0` and a blank field becoming "sold out" is exactly the failure this module exists to stop.
 */
const readNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The first candidate field that reads as a real number.
 *
 * Explicit `Number.isFinite` checks rather than `a ?? b`: several of these quantities are
 * legitimately `0`, and `??`/`||` chains over aliased columns are a documented way to lose them.
 * Note also that `remaining_qty` and `balance_qty` come out of one column in the Rust snapshot, so
 * only their presence differs, never their value.
 */
const firstReadableNumber = (...candidates) => {
  for (const candidate of candidates) {
    const parsed = readNumber(candidate);
    if (parsed !== null) return parsed;
  }
  return null;
};

const roundQuantity = (value) => Number(value.toFixed(QUANTITY_DECIMALS));

const kg = (value) => `${roundQuantity(value).toFixed(QUANTITY_DECIMALS)} kg`;

/** Calendar date in the shop's own time, as a day number, so day arithmetic is subtraction. */
const shopDayNumber = (epochMs, offsetMinutes) =>
  Math.floor((epochMs + offsetMinutes * 60 * 1000) / MS_PER_DAY);

/** Hour of day (0-23) in the shop's own time. */
const shopHour = (epochMs, offsetMinutes) => {
  const shifted = epochMs + offsetMinutes * 60 * 1000;
  return Math.floor(((shifted % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY / (60 * 60 * 1000));
};

const readTimestamp = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
};

const MESSAGES = Object.freeze({
  [AVAILABILITY.SOLD_OUT]: "Sold out today. Ask the shop when the next lot arrives.",
  [AVAILABILITY.UNKNOWN]:
    "We could not check today's stock for this item. Message or call the shop and we will confirm it for you.",
});

/**
 * Turn whatever the catalogue feed said about one product into a state the page can render.
 *
 * `availableKg` is `null` — never `0` — when the state is `UNKNOWN`, so a page that prints the
 * number cannot accidentally print a zero we never measured.
 *
 * Options:
 *   - `lowStockKg`  threshold for LIMITED (default 5).
 *   - `loadFailed`  the caller knows the fetch failed. Forces UNKNOWN whatever the product says.
 *   - `stockKnown`  pass `false` for the same effect, when the caller tracks it as a flag.
 * A product may also carry `stockKnown: false` itself, for a feed that marks individual rows stale.
 */
export const resolveAvailability = (product, options = {}) => {
  const { lowStockKg = DEFAULT_LOW_STOCK_KG, loadFailed = false, stockKnown } = options || {};
  const threshold = readNumber(lowStockKg);
  const limit = threshold !== null && threshold >= 0 ? threshold : DEFAULT_LOW_STOCK_KG;

  const unknown = (message = MESSAGES[AVAILABILITY.UNKNOWN]) => ({
    state: AVAILABILITY.UNKNOWN,
    availableKg: null,
    limited: false,
    message,
  });

  if (loadFailed === true || stockKnown === false) return unknown();
  if (!product || typeof product !== "object") return unknown();
  if (product.stockKnown === false || product.stock_known === false) return unknown();

  const quantity = firstReadableNumber(
    product.availableKg,
    product.available_kg,
    product.available_qty,
    product.balance_qty,
    product.remaining_qty,
    product.current_stock,
  );

  // Missing, unreadable, or negative all mean the same thing: the feed did not tell us the truth.
  // A negative balance is an inconsistency in the source, not an empty shelf, so it is UNKNOWN
  // rather than SOLD_OUT — the shop may well have the fruit.
  if (quantity === null || quantity < 0) return unknown();

  const availableKg = roundQuantity(quantity);
  if (availableKg === 0) {
    return {
      state: AVAILABILITY.SOLD_OUT,
      availableKg: 0,
      limited: false,
      message: MESSAGES[AVAILABILITY.SOLD_OUT],
    };
  }
  if (availableKg <= limit) {
    return {
      state: AVAILABILITY.LIMITED,
      availableKg,
      limited: true,
      message: `Only ${kg(availableKg)} left today — order soon.`,
    };
  }
  return {
    state: AVAILABILITY.IN_STOCK,
    availableKg,
    limited: false,
    message: `In stock today — ${kg(availableKg)} in the shop.`,
  };
};

/** Only stock we have actually seen may be ordered. UNKNOWN is not an invitation to try. */
export const canOrder = (state) => state === AVAILABILITY.IN_STOCK || state === AVAILABILITY.LIMITED;

/**
 * The largest quantity this customer may actually order.
 *
 * The return shape is a record, not a bare number, and that is the point. "Nothing left" and "we do
 * not know" both have to yield `0` — we will not put an order through in either case — but they are
 * completely different things to say to a customer, and a caller that only sees `0` would say the
 * wrong one. So `reason` is always populated from `CLAMP_REASON` and is *never* `NONE` when
 * `quantityKg` is `0`, and `stockKnown` is a separate boolean that is false only for UNKNOWN.
 * A page cannot render this without deciding which case it is looking at.
 */
export const clampToAvailable = (requestedKg, availability) => {
  const state = availability?.state ?? AVAILABILITY.UNKNOWN;
  const requested = readNumber(requestedKg);

  if (state === AVAILABILITY.UNKNOWN) {
    return {
      quantityKg: 0,
      clamped: true,
      stockKnown: false,
      reason: CLAMP_REASON.UNKNOWN_STOCK,
      message: MESSAGES[AVAILABILITY.UNKNOWN],
    };
  }
  if (state === AVAILABILITY.SOLD_OUT) {
    return {
      quantityKg: 0,
      clamped: true,
      stockKnown: true,
      reason: CLAMP_REASON.SOLD_OUT,
      message: MESSAGES[AVAILABILITY.SOLD_OUT],
    };
  }
  if (requested === null || requested <= 0) {
    return {
      quantityKg: 0,
      clamped: false,
      stockKnown: true,
      reason: CLAMP_REASON.INVALID_REQUEST,
      message: "Enter how many kilos you would like.",
    };
  }

  const available = readNumber(availability?.availableKg);
  // A state that says orderable but carries no number is not trustworthy either.
  if (available === null || available <= 0) {
    return {
      quantityKg: 0,
      clamped: true,
      stockKnown: false,
      reason: CLAMP_REASON.UNKNOWN_STOCK,
      message: MESSAGES[AVAILABILITY.UNKNOWN],
    };
  }

  const wanted = roundQuantity(requested);
  if (wanted <= available) {
    return {
      quantityKg: wanted,
      clamped: false,
      stockKnown: true,
      reason: CLAMP_REASON.NONE,
      message: "",
    };
  }
  const granted = roundQuantity(available);
  return {
    quantityKg: granted,
    clamped: true,
    stockKnown: true,
    reason: CLAMP_REASON.LIMITED_STOCK,
    message: `We only have ${kg(granted)} of this today, so that is what we have put in your basket.`,
  };
};

/**
 * How fresh this lot is, in plain English, or `null`.
 *
 * `null` rather than a vague string when there is no usable arrival time, so the page can leave the
 * line out entirely. "Freshness unknown" printed under a mango helps nobody.
 *
 * The comparison is by **calendar day in the shop's time**, not by elapsed hours. A crate that came
 * in at 21:30 and a customer looking at 07:00 the next morning are fourteen hours apart, which a
 * 24-hour span would call "today" — but the customer means yesterday, and so does the shop.
 */
export const describeFreshness = (product, nowMs = Date.now(), options = {}) => {
  const offsetMinutes = readNumber(options?.shopUtcOffsetMinutes) ?? SHOP_UTC_OFFSET_MINUTES;
  const now = readNumber(nowMs);
  if (now === null) return null;
  if (!product || typeof product !== "object") return null;

  const arrivedAt = [
    product.arrivedAt,
    product.arrived_at,
    product.arrivalAt,
    product.arrival_date,
    product.lot_arrival_date,
  ].reduce((found, candidate) => (found === null ? readTimestamp(candidate) : found), null);
  if (arrivedAt === null) return null;

  const days = shopDayNumber(now, offsetMinutes) - shopDayNumber(arrivedAt, offsetMinutes);
  // A lot dated in the future is a data problem, not a freshness claim. Say nothing.
  if (days < 0) return null;
  if (days === 0) {
    return shopHour(arrivedAt, offsetMinutes) < 12 ? "Arrived this morning" : "Arrived today";
  }
  if (days === 1) return "Arrived yesterday";
  if (days < 7) return `Arrived ${days} days ago`;
  return "Arrived over a week ago";
};
