/**
 * How FROST opens a conversation.
 *
 * Asked for in these words: "he should greet me in the beginning depending on the time."
 *
 * Two rules shape this module, and both are the house rule about errors never rendering as
 * something that looks fine:
 *
 * 1. **An unreadable clock does not get a guess.** If the time cannot be determined, FROST says
 *    "Good to see you" — which is true at any hour — rather than picking a band and greeting the
 *    owner with "Good morning" at ten at night. A wrong greeting is small, but it is the same
 *    mistake as a wrong figure: stated with confidence, from nothing.
 * 2. **A missing name is not printed as a blank or as "undefined".** The greeting drops the name
 *    and stays a whole sentence.
 *
 * The bands are the shop's day, not a calendar's: the mandi run starts before dawn, so 5am is
 * morning and not night.
 */

export const FROST_GREETING_BANDS = [
  { id: "morning", from: 5, to: 12, greeting: "Good morning" },
  { id: "afternoon", from: 12, to: 17, greeting: "Good afternoon" },
  { id: "evening", from: 17, to: 21, greeting: "Good evening" },
  { id: "night", from: 21, to: 5, greeting: "Working late" },
];

/** The neutral greeting, used whenever the hour cannot be established. True at every hour. */
export const FROST_GREETING_FALLBACK = "Good to see you";

const readHour = (now) => {
  const date = now instanceof Date ? now : new Date(now);
  const hour = date.getHours();
  return Number.isInteger(hour) ? hour : null;
};

/**
 * The band covering `hour`, or null when the hour is not a real hour.
 *
 * `night` wraps midnight, so its window is tested as two halves rather than one range — a plain
 * `from <= hour && hour < to` would make it match nothing at all, and the caller would silently
 * fall back to the neutral greeting forever without anything looking broken.
 */
export const resolveGreetingBand = (hour) => {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
  return FROST_GREETING_BANDS.find(({ from, to }) => (from < to ? hour >= from && hour < to : hour >= from || hour < to)) || null;
};

/**
 * FROST's opening line.
 *
 * Returns `{ band, greeting, line }`. `band` is null when the clock could not be read, which is how
 * a caller can tell a real greeting from the safe one without comparing strings.
 */
export const resolveFrostGreeting = ({ now = new Date(), name = "" } = {}) => {
  const band = resolveGreetingBand(readHour(now));
  const greeting = band ? band.greeting : FROST_GREETING_FALLBACK;
  const trimmedName = String(name || "").trim();
  return {
    band: band ? band.id : null,
    greeting,
    line: trimmedName ? `${greeting}, ${trimmedName}.` : `${greeting}.`,
  };
};

/**
 * The line under the greeting, which invites a question instead of leaving a blank panel.
 *
 * Kept here rather than in the component so the whole opening is one testable thing.
 */
export const FROST_GREETING_PROMPT = "What would you like to know about the business?";
