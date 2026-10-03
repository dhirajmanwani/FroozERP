// ---------------------------------------------------------------------------------------------
// Dashboard box order (3 Oct 2026)
//
// The owner asked for three dots at the top right of each Dashboard box, to hold and drag the box
// up or down. The order is kept on this computer, per login, like the price-list reminder time:
// it is a preference of the person at this screen, not business data, and it never leaves the
// device. A saved order is always repaired against the boxes this build actually has, so a box
// added later still appears (at its default place) and a removed one is simply dropped.
// ---------------------------------------------------------------------------------------------

/** Every movable Dashboard box, in the default order. `label` is what the move menu names. */
export const DASHBOARD_BLOCKS = Object.freeze([
  Object.freeze({ id: "priceList", label: "Today's price list" }),
  Object.freeze({ id: "welcome", label: "Welcome and New POS Bill" }),
  Object.freeze({ id: "kpis", label: "Today's figures" }),
  Object.freeze({ id: "graphs", label: "Business graphs" }),
  Object.freeze({ id: "highlights", label: "Insights, top products and low stock" }),
  Object.freeze({ id: "quickAccess", label: "Daily operations" }),
]);

export const DEFAULT_DASHBOARD_ORDER = Object.freeze(DASHBOARD_BLOCKS.map((block) => block.id));

const KNOWN_IDS = new Set(DEFAULT_DASHBOARD_ORDER);

export const DASHBOARD_ORDER_KEY_PREFIX = "froozerp.dashboard.order";

/** The storage key for one login. A login without an id shares one "anyone" key. */
export const dashboardOrderKey = (userId) => {
  const id = userId === null || userId === undefined ? "" : String(userId).trim();
  return id === "" ? `${DASHBOARD_ORDER_KEY_PREFIX}.anyone` : `${DASHBOARD_ORDER_KEY_PREFIX}.${id}`;
};

/**
 * A complete order of the known boxes: the saved ids that still exist, each once, then every box
 * the saved order lacks, in its default position relative to the others. Anything that is not an
 * array gives the default order.
 */
export const normalizeDashboardOrder = (saved) => {
  if (!Array.isArray(saved)) return [...DEFAULT_DASHBOARD_ORDER];
  const order = [];
  for (const id of saved) {
    if (typeof id === "string" && KNOWN_IDS.has(id) && !order.includes(id)) order.push(id);
  }
  DEFAULT_DASHBOARD_ORDER.forEach((id, defaultIndex) => {
    if (order.includes(id)) return;
    // Put a missing box right after the nearest box that comes before it by default.
    let insertAt = 0;
    for (let index = defaultIndex - 1; index >= 0; index -= 1) {
      const position = order.indexOf(DEFAULT_DASHBOARD_ORDER[index]);
      if (position !== -1) {
        insertAt = position + 1;
        break;
      }
    }
    order.splice(insertAt, 0, id);
  });
  return order;
};

export const isDefaultDashboardOrder = (order) => {
  const normalized = normalizeDashboardOrder(order);
  return normalized.every((id, index) => id === DEFAULT_DASHBOARD_ORDER[index]);
};

/**
 * Moves one box so it lands at `toIndex` of the resulting order (clamped to the ends). An unknown
 * id, or one already there, returns the same order unchanged.
 */
export const moveDashboardBlock = (order, id, toIndex) => {
  const current = normalizeDashboardOrder(order);
  const from = current.indexOf(id);
  if (from === -1 || !Number.isFinite(toIndex)) return current;
  const target = Math.max(0, Math.min(current.length - 1, Math.trunc(toIndex)));
  if (target === from) return current;
  const next = current.filter((entry) => entry !== id);
  next.splice(target, 0, id);
  return next;
};

/** One step up (-1) or down (+1); at either end nothing moves. */
export const nudgeDashboardBlock = (order, id, delta) => {
  const current = normalizeDashboardOrder(order);
  const from = current.indexOf(id);
  if (from === -1) return current;
  return moveDashboardBlock(current, id, from + Math.sign(Number(delta) || 0));
};

/**
 * Where a dragged box would land. `others` are the midpoints (screen Y) of every other box, top to
 * bottom; the box goes after each midpoint the pointer has passed. The result is the index in the
 * full order, ready for `moveDashboardBlock`.
 */
export const dashboardDropIndex = (otherMidpoints, pointerY) => {
  if (!Array.isArray(otherMidpoints) || !Number.isFinite(pointerY)) return null;
  let index = 0;
  for (const midpoint of otherMidpoints) {
    if (Number.isFinite(midpoint) && pointerY > midpoint) index += 1;
  }
  return index;
};

/** The saved order for this login, repaired; the default when nothing usable is stored. */
export const readDashboardOrder = (storage, userId) => {
  try {
    const raw = storage?.getItem?.(dashboardOrderKey(userId));
    if (typeof raw !== "string" || raw === "") return [...DEFAULT_DASHBOARD_ORDER];
    return normalizeDashboardOrder(JSON.parse(raw));
  } catch {
    return [...DEFAULT_DASHBOARD_ORDER];
  }
};

/**
 * Saves the order, or forgets it when it is the default. False when the device would not store it,
 * so the screen can say the order holds only until the app is closed.
 */
export const writeDashboardOrder = (storage, userId, order) => {
  try {
    if (!storage) return false;
    const key = dashboardOrderKey(userId);
    if (isDefaultDashboardOrder(order)) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(normalizeDashboardOrder(order)));
    return true;
  } catch {
    return false;
  }
};
