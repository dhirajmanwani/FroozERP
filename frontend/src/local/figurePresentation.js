/**
 * Picking and printing a figure that may be unknown.
 *
 * CLAUDE.md: errors must never render as zero. Two screens broke that rule the same way:
 *
 * - **Dashboard tiles.** The local dashboard (`dashboardSnapshot.js`) cannot work out outstanding
 *   balances, expenses, returns, waste or rebates, and says so with `null`. The tiles read them as
 *   `analytics ?? dashboard ?? 0` and then `Number(value || 0)`, so `null` fell through to ₹0.00.
 * - **FROST briefing cards.** A card whose query failed arrives as `{ unavailable: true, error }`,
 *   and `cards[section]?.[key] ?? 0` showed it as ₹0.
 *
 * Here `null` is "unknown" and stays unknown all the way to the screen, where it prints as "—".
 */

export const UNKNOWN_FIGURE = "—";

const isFiniteNumber = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return false;
  return Number.isFinite(Number(value));
};

/**
 * The first candidate that answers. `undefined` means "this source did not say" and the next one
 * is asked; `null` means "this source knows it does not know" and the answer is unknown — a later,
 * staler source must not paper over it. A non-numeric value is treated as not saying.
 */
export const pickDashboardMetric = (...candidates) => {
  for (const candidate of candidates) {
    if (candidate === undefined) continue;
    if (candidate === null) return null;
    if (isFiniteNumber(candidate)) return Number(candidate);
  }
  return null;
};

/** A known figure printed with `format`, or "—". Never `Number(null)`, which is 0. */
export const formatKnownFigure = (value, format = (number) => String(number)) => (
  isFiniteNumber(value) ? format(Number(value)) : UNKNOWN_FIGURE
);

/**
 * One figure on a FROST briefing card: the number, or null when the card is marked unavailable or
 * the field is missing.
 */
export const briefingCardFigure = (cards, section, key) => {
  const card = cards?.[section];
  if (!card || card.unavailable === true) return null;
  const value = card[key];
  return isFiniteNumber(value) ? Number(value) : null;
};

/** The label for the customer card: "Overdue" only when the server sent an overdue total. */
export const customerDueCard = (cards) => {
  const overdue = briefingCardFigure(cards, "customerOutstanding", "totalOverdue");
  if (overdue !== null) return { label: "Customer Overdue", value: overdue };
  return { label: "Customer Outstanding", value: briefingCardFigure(cards, "customerOutstanding", "totalOutstanding") };
};

const BRIEFING_SECTION_NAMES = Object.freeze({
  sales: "sales",
  collections: "collections",
  customerOutstanding: "customer balances",
  supplierOutstanding: "supplier balances",
  pendingPurchases: "pending bills",
  lowStock: "low stock",
  waste: "waste",
  expiringLots: "expiring lots",
});

/** A short note naming the briefing cards the server could not fill, or "" when all answered. */
export const unavailableBriefingNote = (cards) => {
  const names = Object.entries(cards && typeof cards === "object" ? cards : {})
    .filter(([, card]) => card && card.unavailable === true)
    .map(([section]) => BRIEFING_SECTION_NAMES[section] || section);
  return names.length ? `Could not be worked out just now: ${names.join(", ")}. Shown as —, not as zero.` : "";
};

/**
 * A FROST insight card's figure: a number through `formatMoney`, text as it came, and `null`,
 * `undefined` or empty text as "—" marked unavailable. A null value used to render an empty box.
 */
export const insightCardValue = (value, formatMoney = (number) => String(number)) => {
  if (typeof value === "number" && Number.isFinite(value)) return { text: formatMoney(value), unavailable: false };
  if (typeof value === "string" && value.trim()) return { text: value, unavailable: false };
  return { text: UNKNOWN_FIGURE, unavailable: true };
};

/**
 * A tile's value with a negative amount kept in one piece. `currency.format(-1190)` is
 * "-₹1,190.00", and the browser may break a line after the hyphen, so a narrow tile read
 * "-" above "₹1,190.00": at a glance, a positive balance. The sign becomes a true minus (U+2212)
 * held to the figure by a word joiner (U+2060), and `negative` lets the tile colour it.
 * Anything that is not a negative figure is returned as it came.
 */
export const presentSignedFigure = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value < 0 ? { text: `−⁠${String(Math.abs(value))}`, negative: true } : { text: value, negative: false };
  }
  if (typeof value !== "string") return { text: value, negative: false };
  const match = /^\s*[-−]\s*(?=[₹\d])/.exec(value);
  if (!match) return { text: value, negative: false };
  return { text: `−⁠${value.slice(match[0].length)}`, negative: true };
};

/**
 * A chart axis or tooltip figure in rupees, short: ₹950, ₹1.2K, ₹4.5 L, ₹2.1 Cr. The axis used
 * `Intl.NumberFormat("en-IN", { notation: "compact" })`, whose "T" (thousand) read as trillion
 * ("INR 1T" for ₹1,190), and said INR where the rest of the app says ₹.
 */
export const formatChartRupees = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return "₹0";
  const sign = number < 0 ? "−" : "";
  const size = Math.abs(number);
  const short = (amount) => String(Math.round(amount * 10) / 10);
  if (size >= 1e7) return `${sign}₹${short(size / 1e7)} Cr`;
  if (size >= 1e5) return `${sign}₹${short(size / 1e5)} L`;
  if (size >= 1e3) return `${sign}₹${short(size / 1e3)}K`;
  return `${sign}₹${Math.round(size)}`;
};
