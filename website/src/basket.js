/**
 * The customer's basket, and the money it adds up to.
 *
 * Produce sells by the kilo at a rate that moves daily, so a basket line is a *rate* and a *weight*,
 * never a unit price and a count. Quantities carry 3 decimals and money rounds to 2, which is the
 * app's convention and therefore the only one the customer can be shown without two screens
 * disagreeing.
 *
 * Baskets are values. Every function returns a new frozen basket rather than editing the one it was
 * given, so a page can hold the previous basket for an undo, compare two of them, or render one
 * without worrying that a helper mutated it underneath.
 *
 * The other half of the job is refusing bad input loudly. A rate that failed to load must not become
 * a `₹0.00` line — that is the "errors must never render as zero" rule wearing a different hat — so
 * a line that cannot be priced honestly is not added, and `describeLineRejection` says why in words
 * the page can show.
 */

const QUANTITY_DECIMALS = 3;
const MONEY_DECIMALS = 2;

/**
 * Ids are opaque strings and are only ever trimmed, never converted.
 *
 * This mirrors `canonicalInventoryId` / `inventoryIdsEqual` in
 * `frontend/src/local/stockInventory.js` deliberately rather than importing them: the website is a
 * standalone static bundle with no build step and must not reach into the app's source tree. The
 * behaviour has to stay identical, though, because both sides key the same products — `Number()`
 * on one side of a join is what silently emptied the Inventory table once, and `"004"` and `4` are
 * different products in this database.
 */
export const canonicalProductId = (value) => String(value ?? "").trim();

export const productIdsEqual = (left, right) =>
  canonicalProductId(left) !== "" && canonicalProductId(left) === canonicalProductId(right);

/**
 * A number we are willing to believe, or `null`.
 *
 * Form fields hand over strings, so `"2.5"` is accepted. `""`, whitespace, `null`, `undefined`,
 * `NaN`, `Infinity`, booleans and arrays are refused — `Number("")` and `Number(null)` are both
 * `0`, and a blank box quietly becoming a zero is how a basket starts lying.
 */
const readNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
};

const round = (value, decimals) => {
  const factor = 10 ** decimals;
  // Nudge off the binary representation before rounding: 1.005 is stored slightly below 1.005 and
  // would otherwise round down, printing a rupee less than the customer was quoted.
  return Number((Math.round((value * factor) + Number.EPSILON * factor * Math.sign(value)) / factor).toFixed(decimals));
};

export const roundQuantity = (value) => round(value, QUANTITY_DECIMALS);
export const roundMoney = (value) => round(value, MONEY_DECIMALS);

const freezeBasket = (lines) => Object.freeze({ lines: Object.freeze(lines.map((line) => Object.freeze({ ...line }))) });

/** An empty basket. */
export const createBasket = () => freezeBasket([]);

const basketLines = (basket) => (Array.isArray(basket?.lines) ? basket.lines : []);

/**
 * Why this line cannot go in the basket, in words a customer can act on. `""` when it is fine.
 *
 * A rate of `0` is refused along with a missing one. Nobody sells fruit for nothing, so `0` here is
 * overwhelmingly a rate that failed to load, and pricing a line at `₹0.00` on that basis is exactly
 * the failure the design brief and CLAUDE.md both forbid.
 */
export const describeLineRejection = ({ productId, name, ratePerKg, quantityKg } = {}) => {
  const label = String(name || "").trim() || "This item";
  if (canonicalProductId(productId) === "") return "This item is missing its product code, so it cannot be ordered online.";
  const rate = readNumber(ratePerKg);
  if (rate === null || rate <= 0) return `We could not read today's rate for ${label}. Please ask the shop for the price.`;
  const quantity = readNumber(quantityKg);
  if (quantity === null) return `Enter how many kilos of ${label} you would like.`;
  if (quantity <= 0) return `Choose a weight above zero for ${label}.`;
  return "";
};

/**
 * Add a weight of one product, returning a new basket.
 *
 * A product already in the basket has its weight increased instead of gaining a second line —
 * matched on the canonical id, so `"004"` never merges into `4`. A line that fails
 * `describeLineRejection` is not added and the basket comes back unchanged; the page is expected to
 * show that message rather than silently dropping it.
 */
export const addLine = (basket, { productId, name, ratePerKg, quantityKg } = {}) => {
  const lines = basketLines(basket);
  if (describeLineRejection({ productId, name, ratePerKg, quantityKg }) !== "") return freezeBasket(lines);

  const id = canonicalProductId(productId);
  const rate = readNumber(ratePerKg);
  const quantity = roundQuantity(readNumber(quantityKg));
  const index = lines.findIndex((line) => productIdsEqual(line.productId, id));

  if (index === -1) {
    return freezeBasket([...lines, { productId: id, name: String(name ?? "").trim(), ratePerKg: rate, quantityKg: quantity }]);
  }
  const next = lines.slice();
  // The newest rate wins: produce is repriced daily and the customer is quoted what is on screen now.
  next[index] = {
    ...next[index],
    name: String(name ?? "").trim() || next[index].name,
    ratePerKg: rate,
    quantityKg: roundQuantity(next[index].quantityKg + quantity),
  };
  return freezeBasket(next);
};

/**
 * Set one line's weight, returning a new basket. Zero or less removes the line.
 *
 * An unreadable quantity — a half-typed number, a cleared field — leaves the basket alone rather
 * than removing the line. Losing a line to a typo is worse than ignoring one keystroke.
 */
export const setLineQuantity = (basket, productId, quantityKg) => {
  const lines = basketLines(basket);
  const quantity = readNumber(quantityKg);
  if (quantity === null) return freezeBasket(lines);
  if (quantity <= 0) return removeLine(basket, productId);
  return freezeBasket(lines.map((line) => (
    productIdsEqual(line.productId, productId) ? { ...line, quantityKg: roundQuantity(quantity) } : line
  )));
};

/** Drop a line, returning a new basket. */
export const removeLine = (basket, productId) =>
  freezeBasket(basketLines(basket).filter((line) => !productIdsEqual(line.productId, productId)));

/** The line the page is looking for, or `undefined`. */
export const findLine = (basket, productId) =>
  basketLines(basket).find((line) => productIdsEqual(line.productId, productId));

/**
 * What one line costs: weight rounded to 3, times the rate, rounded to 2.
 *
 * This is the number that gets printed next to the line, and it is the only rounding of money that
 * happens anywhere. See `basketTotals`.
 */
export const lineTotal = (line) => {
  const rate = readNumber(line?.ratePerKg);
  const quantity = readNumber(line?.quantityKg);
  if (rate === null || quantity === null) return 0;
  return roundMoney(roundQuantity(quantity) * rate);
};

/** Lines with their printed totals attached, ready to render. */
export const basketRows = (basket) =>
  basketLines(basket).map((line) => ({ ...line, total: lineTotal(line) }));

/**
 * Basket totals.
 *
 * **Rounding happens once per line, and the subtotal is the sum of those already-rounded lines.**
 * That is deliberate and it is not the same answer as accumulating full precision and rounding once
 * at the end. The customer can see every line total printed on the page; if they add them up on
 * paper — and for a produce order of six lines they will — their arithmetic has to match the total
 * we charge. A grand total that is a paisa away from the lines it is made of is the kind of thing
 * that costs trust far out of proportion to the amount.
 *
 * The final `roundMoney` on the sum only clears floating-point dust from adding 2-decimal values; it
 * cannot move the answer by more than a rounding error.
 */
export const basketTotals = (basket) => {
  const lines = basketLines(basket);
  return {
    lineCount: lines.length,
    totalKg: roundQuantity(lines.reduce((sum, line) => sum + (readNumber(line?.quantityKg) ?? 0), 0)),
    subtotal: roundMoney(lines.reduce((sum, line) => sum + lineTotal(line), 0)),
  };
};

const quantityFormatter = new Intl.NumberFormat("en-IN", {
  minimumFractionDigits: QUANTITY_DECIMALS,
  maximumFractionDigits: QUANTITY_DECIMALS,
});

/**
 * Indian digit grouping, from `Intl` rather than by hand: `₹1,09,340.75`, not `₹109,340.75`.
 * The app formats money the same way, and a customer seeing both must not see two conventions.
 */
const rupeeFormatter = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: MONEY_DECIMALS,
  maximumFractionDigits: MONEY_DECIMALS,
});

/** Shown when a number could not be read. An em dash, never a zero — the site does not invent figures. */
export const UNKNOWN_DISPLAY = "—";

/** `2.5` becomes `"2.500 kg"`. Weight is always shown with its unit; the brief is explicit about it. */
export const formatKg = (value) => {
  const parsed = readNumber(value);
  if (parsed === null) return UNKNOWN_DISPLAY;
  return `${quantityFormatter.format(roundQuantity(parsed))} kg`;
};

/** `109340.75` becomes `"₹1,09,340.75"`. */
export const formatRupees = (value) => {
  const parsed = readNumber(value);
  if (parsed === null) return UNKNOWN_DISPLAY;
  return rupeeFormatter.format(roundMoney(parsed));
};

/** `"₹80.00 / kg"` — a price with no unit beside it is the commonest confusion in this category. */
export const formatRatePerKg = (value) => {
  const parsed = readNumber(value);
  if (parsed === null) return UNKNOWN_DISPLAY;
  return `${formatRupees(parsed)} / kg`;
};
