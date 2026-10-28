/**
 * Leaving POS with a bill on the counter.
 *
 * The cart lives inside the POS screen, so leaving the screen throws it away. There is no held or
 * parked bill (the owner chose a question over a parking feature, 24 Oct 2026): before the sidebar,
 * Ctrl K, an Alt key or the Back button takes the cashier elsewhere mid-bill, the app asks.
 *
 * The question is an in-app dialog, never a browser box.
 */

export const POS_VIEW = "sales";

export const POS_LEAVE_PROMPT = Object.freeze({
  title: "Leave POS?",
  message: "The bill in progress will be cleared.",
  stay: "Stay",
  leave: "Leave",
});

/**
 * True when going from `activeView` to `nextView` would clear a bill in progress. `nextView` may be
 * null for "somewhere else" (the Back and Forward buttons, which do not know where they lead).
 */
export const shouldConfirmLeavingPos = ({ activeView, nextView = null, cartLines = 0 } = {}) => {
  if (activeView !== POS_VIEW) return false;
  if (nextView === POS_VIEW) return false;
  const lines = Number(cartLines);
  return Number.isFinite(lines) && lines > 0;
};
