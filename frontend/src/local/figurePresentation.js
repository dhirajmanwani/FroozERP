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
