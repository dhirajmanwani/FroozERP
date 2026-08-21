/**
 * The life of an online order, and the stock it is holding while it lives.
 *
 * G7's order half. The maintainer ruled on 2026-08-21 that accepting an order **reserves** stock —
 * the alternative, merely noting the order down, oversells, and selling fruit you do not have
 * produces a refund and a customer who does not come back. That ruling is what makes this a state
 * machine rather than a list: reserved stock has to be given back when an order dies, and every way
 * an order can die is an edge that has to be named.
 *
 * The second ruling: **sending creates the bill.** So `SENT` is the moment stock genuinely leaves
 * and the customer is charged — everything before it is a promise, everything after is history.
 * That makes `SENT` the only irreversible step here, and the transition table treats it as such.
 *
 * ## The lapse, and why it is not a cancellation
 *
 * A reservation cannot be held for ever: an order taken on Tuesday and forgotten would hold stock
 * hostage indefinitely, and for produce that stock will not survive the wait anyway. But silently
 * **cancelling** a customer's order is worse than holding stock — the customer is still expecting
 * their fruit and now nobody knows.
 *
 * So a reservation *lapses*: the stock returns to available, the order stays exactly where it was,
 * and it is flagged as needing attention. That is the same rule as everywhere else in this codebase
 * — surface the problem, never quietly resolve it. Someone has to look at a lapsed order and decide,
 * because only a person knows whether the customer still wants it.
 */

export const ORDER_STATUS = Object.freeze({
  RECEIVED: "RECEIVED",
  PACKED: "PACKED",
  SENT: "SENT",
  DELIVERED: "DELIVERED",
  CANCELLED: "CANCELLED",
  RETURNED: "RETURNED",
});

/** Statuses in which an order is holding stock away from the counter. */
export const RESERVING_STATUSES = Object.freeze([ORDER_STATUS.RECEIVED, ORDER_STATUS.PACKED]);

/**
 * How long an unpacked order may hold stock. Six hours: long enough for a morning order to be
 * packed in the afternoon, short enough that nothing is held overnight.
 */
export const RESERVATION_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * Legal moves.
 *
 * Written as an explicit table rather than as `if` chains, because the interesting property is what
 * is *absent*: nothing returns from `SENT` to `PACKED`, because the bill has been raised and the
 * stock has gone. Undoing that is a sale return, which is a separate recorded event with its own
 * money attached — not an edit to this order's status.
 */
const TRANSITIONS = Object.freeze({
  [ORDER_STATUS.RECEIVED]: [ORDER_STATUS.PACKED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.PACKED]: [ORDER_STATUS.SENT, ORDER_STATUS.RECEIVED, ORDER_STATUS.CANCELLED],
  [ORDER_STATUS.SENT]: [ORDER_STATUS.DELIVERED, ORDER_STATUS.RETURNED],
  [ORDER_STATUS.DELIVERED]: [],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.RETURNED]: [],
});

export const RESERVATION_STATE = Object.freeze({
  ACTIVE: "ACTIVE",
  LAPSED: "LAPSED",
  CONSUMED: "CONSUMED",
  RELEASED: "RELEASED",
});

const asTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const asQty = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

/** The moves available from a status. Unknown statuses offer none rather than throwing. */
export const nextStatuses = (status) => TRANSITIONS[status] || [];

export const canTransition = (from, to) => nextStatuses(from).includes(to);

/**
 * Why a move is refused, in words a counter operator can act on.
 *
 * Returns "" when the move is allowed. The messages name the alternative rather than only the
 * refusal: "you cannot un-send this" is a dead end, "record a sale return" is an instruction.
 */
export const transitionRefusal = (from, to) => {
  if (canTransition(from, to)) return "";
  if (!TRANSITIONS[from]) return `${from || "This order"} is not a status this app knows.`;
  if (from === ORDER_STATUS.SENT && (to === ORDER_STATUS.PACKED || to === ORDER_STATUS.RECEIVED)) {
    return "This order has already been sent and billed. To undo it, record a sale return.";
  }
  if (from === ORDER_STATUS.SENT && to === ORDER_STATUS.CANCELLED) {
    return "A sent order cannot be cancelled. Record a sale return if it comes back.";
  }
  if (from === ORDER_STATUS.CANCELLED) return "This order was cancelled. Create a new order instead.";
  if (from === ORDER_STATUS.DELIVERED) return "This order is finished.";
  if (from === ORDER_STATUS.RETURNED) return "This order came back. Record a sale return if it has not been done.";
  return `An order cannot go from ${from} to ${to}.`;
};

/**
 * What has become of an order's hold on stock.
 *
 * `CONSUMED` rather than `RELEASED` once sent: the stock did not come back to the shelf, it left
 * with the customer. Two different things that would both otherwise read as "no longer reserved",
 * and only one of them means the stock is available again.
 */
export const reservationState = (order, nowMs = Date.now()) => {
  const status = order?.status;
  if (status === ORDER_STATUS.SENT || status === ORDER_STATUS.DELIVERED || status === ORDER_STATUS.RETURNED) {
    return RESERVATION_STATE.CONSUMED;
  }
  if (status === ORDER_STATUS.CANCELLED) return RESERVATION_STATE.RELEASED;
  if (!RESERVING_STATUSES.includes(status)) return RESERVATION_STATE.RELEASED;
  // Packing is the commitment. Once someone has physically set the goods aside, the reservation is
  // no longer a promise the shop might forget — it is a box on the floor, and lapsing it would put
  // stock back on the books that is not on the shelf.
  if (status === ORDER_STATUS.PACKED) return RESERVATION_STATE.ACTIVE;
  const reservedAt = asTime(order?.reserved_at ?? order?.created_at);
  if (reservedAt === null) return RESERVATION_STATE.ACTIVE;
  return nowMs - reservedAt >= RESERVATION_TTL_MS
    ? RESERVATION_STATE.LAPSED
    : RESERVATION_STATE.ACTIVE;
};

/** True when this order is currently keeping stock away from the counter. */
export const isHoldingStock = (order, nowMs = Date.now()) =>
  reservationState(order, nowMs) === RESERVATION_STATE.ACTIVE;

/**
 * Quantity reserved per product, across every order still holding stock.
 *
 * Keyed by the canonical product id as a string. Ids in this codebase are opaque strings and
 * coercing them with `Number()` is a documented way to silently lose rows — `"004"` and `4` are
 * different products — so they are only ever trimmed, never converted.
 */
export const reservedQuantityByProduct = (orders = [], nowMs = Date.now()) => {
  const totals = new Map();
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!isHoldingStock(order, nowMs)) continue;
    for (const line of Array.isArray(order?.items) ? order.items : []) {
      const productId = String(line?.product_id ?? "").trim();
      if (!productId) continue;
      totals.set(productId, (totals.get(productId) || 0) + asQty(line?.quantity));
    }
  }
  return totals;
};

/**
 * What the counter may still sell.
 *
 * Clamped at zero, and the clamp is reported rather than hidden. A negative here means reservations
 * exceed the stock on hand, which is not a display problem — it means the shop has promised fruit it
 * does not have, and somebody needs to know before a customer does.
 */
export const availableQuantity = ({ onHand = 0, reserved = 0 } = {}) => {
  const stock = Number(onHand);
  const held = Number(reserved);
  const safeStock = Number.isFinite(stock) ? stock : 0;
  const safeHeld = Number.isFinite(held) ? held : 0;
  const remaining = safeStock - safeHeld;
  return {
    available: Math.max(0, remaining),
    reserved: safeHeld,
    onHand: safeStock,
    oversold: remaining < 0,
    shortfall: remaining < 0 ? Math.abs(remaining) : 0,
  };
};

/**
 * Orders a person needs to look at, and why.
 *
 * A lapsed reservation is the main one: the stock went back to the shelf and may since have been
 * sold, so the order cannot simply be packed as though nothing happened. The message says what to
 * do, because "needs attention" on its own is a badge, not information.
 */
export const ordersNeedingAttention = (orders = [], nowMs = Date.now()) =>
  (Array.isArray(orders) ? orders : [])
    .filter((order) => reservationState(order, nowMs) === RESERVATION_STATE.LAPSED)
    .map((order) => ({
      orderId: order?.id ?? null,
      orderNo: order?.order_no || "",
      customerName: order?.customer_name || "Walk-in customer",
      reason: "The stock held for this order was released after six hours. Check it is still in the shop before packing.",
    }));
