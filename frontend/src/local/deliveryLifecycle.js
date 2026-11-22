/**
 * The life of one delivery attempt, and how it pushes on the order it carries.
 *
 * Rapido and Uber riders are booked by hand in their own apps; this app only keeps track of the
 * booking. So a delivery is a second, smaller state machine that sits *beside* the order's own
 * (`orderLifecycle.js`) rather than replacing it:
 *
 *     pending -> booked -> picked_up -> delivered -> closed
 *        \          \           \
 *         cancelled  cancelled   failed
 *                    failed
 *
 * Three rulings from the approved plan (22 Nov 2026) shape it:
 *
 *   1. **Picked up is the moment to press Send.** Sending an order creates the bill, so the stock
 *      leaves and the customer is charged when the rider has the parcel, not when a rider was merely
 *      booked. {@link orderEffectOfDeliveryMove} names that link; the screen carries it out through
 *      the existing order status command, because a delivery never changes an order's status by
 *      itself (the Rust write commands deliberately do not).
 *   2. **A failed or cancelled attempt is history, not a dead end.** The order stays where it was and
 *      a new attempt (`attempt_no + 1`) can be started. Nothing is edited back to `pending`: a second
 *      rider is a second row, so the cost and the reason of the first one are never overwritten.
 *   3. **`cancelled` and `failed` need a reason.** "Failed" with no reason is a report nobody can act
 *      on, and the owner reads these to decide whether a provider or an area is worth keeping.
 *
 * ## Money
 *
 * Integer paise, everywhere, like the tables. `final_paise` NULL means "the same as quoted"; when a
 * delivery is closed with the final left blank, the quoted amount is what gets written. Picking
 * between the two is done with explicit `Number.isFinite` checks and never with `??` or `||`: a
 * charge of **0** (own staff, a free drop next door) is a real answer, and `final ?? quoted` would
 * also happily accept `""`. `CLAUDE.md` records that trap for exactly these fields.
 *
 * Pure: no clock read inside, no React, no I/O. `nowMs` is passed in wherever an age is computed.
 */

import { ORDER_STATUS } from "./orderLifecycle.js";
import { canonicalInventoryId } from "./stockInventory.js";

export const DELIVERY_STATUS = Object.freeze({
  PENDING: "pending",
  BOOKED: "booked",
  PICKED_UP: "picked_up",
  DELIVERED: "delivered",
  CLOSED: "closed",
  CANCELLED: "cancelled",
  FAILED: "failed",
});

export const DELIVERY_STATUS_LABEL = Object.freeze({
  pending: "Pending",
  booked: "Booked",
  picked_up: "Picked up",
  delivered: "Delivered",
  closed: "Closed",
  cancelled: "Cancelled",
  failed: "Failed",
});

export const PAID_BY = Object.freeze({ SHOP: "shop", CUSTOMER: "customer" });

export const PAID_BY_LABEL = Object.freeze({ shop: "Shop", customer: "Customer" });

/** Still being worked on: a person or a rider owes this delivery something. */
export const OPEN_DELIVERY_STATUSES = Object.freeze([
  DELIVERY_STATUS.PENDING,
  DELIVERY_STATUS.BOOKED,
  DELIVERY_STATUS.PICKED_UP,
]);

/**
 * Finished, one way or another. `delivered` is deliberately in neither list: the parcel has arrived
 * but the money (the final charge) has not been settled, so it is not open work and not yet history.
 */
export const TERMINAL_DELIVERY_STATUSES = Object.freeze([
  DELIVERY_STATUS.CLOSED,
  DELIVERY_STATUS.CANCELLED,
  DELIVERY_STATUS.FAILED,
]);

export const REASON_REQUIRED_STATUSES = Object.freeze([DELIVERY_STATUS.CANCELLED, DELIVERY_STATUS.FAILED]);

export const KNOWN_DELIVERY_STATUSES = Object.freeze(Object.values(DELIVERY_STATUS));

/** Minutes in one open status before the board turns a card red. */
export const DEFAULT_OVERDUE_MINUTES = 45;

/**
 * The largest charge this app will write, in paise (Rs 1,00,00,00,000). The cloud sanitiser refuses
 * anything above it, so a typo past this would otherwise be accepted here and then stall the order's
 * sync instead of being caught at the keyboard.
 */
export const MAX_DELIVERY_PAISE = 100000000000;

/**
 * Legal moves, as a table so that what is *absent* is easy to read: nothing goes backwards, and a
 * parcel the rider already has cannot be "cancelled" — it either arrives or it failed.
 */
const TRANSITIONS = Object.freeze({
  [DELIVERY_STATUS.PENDING]: Object.freeze([DELIVERY_STATUS.BOOKED, DELIVERY_STATUS.CANCELLED]),
  [DELIVERY_STATUS.BOOKED]: Object.freeze([DELIVERY_STATUS.PICKED_UP, DELIVERY_STATUS.CANCELLED, DELIVERY_STATUS.FAILED]),
  [DELIVERY_STATUS.PICKED_UP]: Object.freeze([DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.FAILED]),
  [DELIVERY_STATUS.DELIVERED]: Object.freeze([DELIVERY_STATUS.CLOSED]),
  [DELIVERY_STATUS.CLOSED]: Object.freeze([]),
  [DELIVERY_STATUS.CANCELLED]: Object.freeze([]),
  [DELIVERY_STATUS.FAILED]: Object.freeze([]),
});

const statusOf = (value) => String(value ?? "").trim().toLowerCase();

const labelOf = (status) => DELIVERY_STATUS_LABEL[status] || status || "blank";

const asTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

/** The moves available from a status. Unknown statuses offer none rather than throwing. */
export const nextDeliveryStatuses = (status) => TRANSITIONS[statusOf(status)] || [];

export const canMoveDelivery = (from, to) => nextDeliveryStatuses(from).includes(statusOf(to));

/**
 * Whether a move may be made, and if not, why — in words a counter operator can act on.
 *
 * The messages name the alternative where there is one ("mark it Failed"), because "not allowed" on
 * its own is a dead end. The reason rule is checked here as well as in Rust, so the screen can say
 * so before anything is written.
 *
 * @returns {{ok: true} | {ok: false, message: string}}
 */
export const validateDeliveryMove = ({ delivery, to, reason } = {}) => {
  if (!delivery || typeof delivery !== "object") {
    return { ok: false, message: "This delivery could not be read. Reopen the order and try again." };
  }
  const from = statusOf(delivery.status);
  const target = statusOf(to);
  if (!TRANSITIONS[from]) {
    return { ok: false, message: `This delivery has a status this app does not know (${from || "blank"}), so it cannot be moved.` };
  }
  if (!TRANSITIONS[target]) {
    return { ok: false, message: `${target || "That"} is not a delivery status this app knows.` };
  }
  if (from === target) return { ok: false, message: `This delivery is already ${labelOf(from)}.` };
  if (!canMoveDelivery(from, target)) {
    if (from === DELIVERY_STATUS.CLOSED) return { ok: false, message: "This delivery is closed. Nothing more can be changed on it." };
    if (from === DELIVERY_STATUS.CANCELLED || from === DELIVERY_STATUS.FAILED) {
      return { ok: false, message: `This delivery was ${labelOf(from).toLowerCase()}. Start a new delivery for the order instead.` };
    }
    if (from === DELIVERY_STATUS.DELIVERED) {
      return { ok: false, message: "This parcel has been delivered. The only step left is to close it with the final charge." };
    }
    if (from === DELIVERY_STATUS.PICKED_UP && target === DELIVERY_STATUS.CANCELLED) {
      return { ok: false, message: "The rider already has the parcel, so it cannot be cancelled. If it did not arrive, mark it Failed with the reason." };
    }
    if (from === DELIVERY_STATUS.PENDING && target === DELIVERY_STATUS.FAILED) {
      return { ok: false, message: "No rider was booked yet, so this delivery cannot have failed. Cancel it with the reason instead." };
    }
    const order = KNOWN_DELIVERY_STATUSES;
    if (order.indexOf(target) < order.indexOf(from)) {
      return { ok: false, message: `A delivery cannot go back from ${labelOf(from)} to ${labelOf(target)}.` };
    }
    return {
      ok: false,
      message: `A delivery cannot go from ${labelOf(from)} straight to ${labelOf(target)}. Mark it ${labelOf(nextDeliveryStatuses(from)[0])} first.`,
    };
  }
  if (REASON_REQUIRED_STATUSES.includes(target) && !String(reason ?? "").trim()) {
    return {
      ok: false,
      message: target === DELIVERY_STATUS.CANCELLED
        ? "Say why this delivery is being cancelled."
        : "Say why this delivery failed (for example: customer not reachable, wrong address, rider cancelled).",
    };
  }
  return { ok: true };
};

/* ------------------------------------------------------------------------------- money ------- */

/**
 * Rupees typed by a person, as integer paise.
 *
 * - blank (`""`, spaces, `null`, `undefined`) -> `null`: nothing was typed, which is not zero;
 * - junk, negative, or beyond {@link MAX_DELIVERY_PAISE} -> `NaN`, so a caller cannot mistake it for
 *   either of the above;
 * - otherwise the amount rounded to the nearest paisa. "₹1,250.50" is accepted as typed.
 */
export const rupeesToPaise = (value) => {
  if (value === null || value === undefined) return null;
  let parsed;
  if (typeof value === "number") {
    parsed = value;
  } else {
    const textValue = String(value).replace(/[₹,\s]/g, "").replace(/^rs\.?/i, "");
    if (!textValue) return String(value).trim() ? Number.NaN : null;
    if (!/^[+-]?(\d+\.?\d*|\.\d+)$/.test(textValue)) return Number.NaN;
    parsed = Number(textValue);
  }
  if (!Number.isFinite(parsed) || parsed < 0) return Number.NaN;
  // Shifting the decimal in the string rather than multiplying by 100 keeps 12.345 at 1235 paise
  // instead of the 1234 that 12.345 * 100 = 1234.4999… would round to.
  let paise = Math.round(Number(`${parsed}e2`));
  if (!Number.isFinite(paise)) paise = Math.round(parsed * 100);
  if (paise > MAX_DELIVERY_PAISE) return Number.NaN;
  return paise;
};

/** Paise as rupees with at most two decimals, or `null` when there is no amount. */
export const paiseToRupees = (paise) => {
  const value = storedPaise(paise);
  return value === null ? null : value / 100;
};

/**
 * A paise value as stored, or `null`.
 *
 * `null`, `undefined` and `""` are "no amount", never 0 — `Number(null)` is 0, which is exactly the
 * coercion this guards against.
 */
export const storedPaise = (value) => {
  if (value === null || value === undefined || value === "" || typeof value === "boolean") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed) : null;
};

/**
 * What a delivery actually cost, in paise: the final charge when one is recorded, else the quoted
 * one, else `null` (nobody has said). Explicit `Number.isFinite` on each, so a final of 0 wins.
 */
export const deliveryChargePaise = (delivery) => {
  const final = storedPaise(delivery?.final_paise);
  if (Number.isFinite(final)) return final;
  const quoted = storedPaise(delivery?.quoted_paise);
  if (Number.isFinite(quoted)) return quoted;
  return null;
};

/**
 * The final charge to write when closing.
 *
 * Blank input means "same as quoted": the closing person was not asked to retype a number nobody
 * disputes. One refinement, matching `local_set_delivery_status` in Rust: if a final charge was
 * already recorded on the delivery (edited after the ride), a blank input keeps it rather than
 * quietly putting the quote back over it. With neither recorded the answer is `null`.
 *
 * A typed amount wins and is returned in paise; junk comes back as `NaN` so the screen can refuse it.
 */
export const closingFinalPaise = (delivery, finalInput) => {
  const typed = rupeesToPaise(finalInput);
  if (typed !== null) return typed;
  const stored = storedPaise(delivery?.final_paise);
  if (Number.isFinite(stored)) return stored;
  const quoted = storedPaise(delivery?.quoted_paise);
  return Number.isFinite(quoted) ? quoted : null;
};

/* -------------------------------------------------------------------------------- time ------- */

const STATUS_STAMP = Object.freeze({
  [DELIVERY_STATUS.PENDING]: "created_at",
  [DELIVERY_STATUS.BOOKED]: "booked_at",
  [DELIVERY_STATUS.PICKED_UP]: "picked_up_at",
  [DELIVERY_STATUS.DELIVERED]: "delivered_at",
  [DELIVERY_STATUS.CLOSED]: "closed_at",
  [DELIVERY_STATUS.CANCELLED]: "cancelled_at",
  [DELIVERY_STATUS.FAILED]: "failed_at",
});

const eventsOf = (delivery) => (Array.isArray(delivery?.events) ? delivery.events.filter((event) => event && typeof event === "object") : []);

/**
 * When this delivery entered its current status, as the ISO string it was stored with.
 *
 * The latest event into that status wins (the events are the record of what happened); then the
 * status's own `<status>_at` stamp; then `updated_at`, then `created_at`. `null` when none of them is
 * a readable time — an age computed from a guessed time would put a red card on the board that
 * nobody can explain.
 */
export const statusEnteredAt = (delivery) => {
  if (!delivery || typeof delivery !== "object") return null;
  const status = statusOf(delivery.status);
  let best = null;
  for (const event of eventsOf(delivery)) {
    if (statusOf(event.to_status) !== status) continue;
    const at = asTime(event.at);
    if (at === null) continue;
    if (best === null || at >= best.at) best = { at, raw: event.at };
  }
  if (best) return typeof best.raw === "string" ? best.raw : new Date(best.at).toISOString();
  for (const field of [STATUS_STAMP[status], "updated_at", "created_at"]) {
    if (field && asTime(delivery[field]) !== null) {
      const raw = delivery[field];
      return typeof raw === "string" ? raw : new Date(asTime(raw)).toISOString();
    }
  }
  return null;
};

/** Whole minutes spent in the current status, or `null` when the entry time cannot be read. */
export const minutesInStatus = (delivery, nowMs) => {
  const entered = asTime(statusEnteredAt(delivery));
  const now = asTime(nowMs);
  if (entered === null || now === null) return null;
  return Math.max(0, Math.floor((now - entered) / 60000));
};

/**
 * Has an open delivery sat in one status too long?
 *
 * Only open statuses can be overdue: a delivered parcel waiting for its charge to be closed is
 * bookkeeping, not a customer waiting at the door. An unreadable time is never overdue — the card
 * stays plain rather than red for a reason nobody could explain.
 */
export const isDeliveryOverdue = (delivery, nowMs, overdueMinutes = DEFAULT_OVERDUE_MINUTES) => {
  if (!OPEN_DELIVERY_STATUSES.includes(statusOf(delivery?.status))) return false;
  const limit = Number(overdueMinutes);
  const threshold = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_OVERDUE_MINUTES;
  const minutes = minutesInStatus(delivery, nowMs);
  return minutes !== null && minutes >= threshold;
};

/* ------------------------------------------------------------------- deliveries of an order --- */

const attemptOf = (delivery) => {
  const parsed = Number(delivery?.attempt_no);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/**
 * An order's delivery attempts, first attempt first.
 *
 * `attempt_no` is a counter, not an id, so it is compared as a number. An attempt with an unreadable
 * number sorts last and is still returned: dropping it would hide a delivery that exists.
 */
export const deliveriesOf = (order) => {
  const list = Array.isArray(order?.deliveries) ? order.deliveries.filter((entry) => entry && typeof entry === "object") : [];
  return list
    .map((delivery, index) => ({ delivery, index }))
    .sort((left, right) => {
      const a = attemptOf(left.delivery);
      const b = attemptOf(right.delivery);
      if (a !== null && b !== null && a !== b) return a - b;
      if (a === null && b !== null) return 1;
      if (b === null && a !== null) return -1;
      return left.index - right.index;
    })
    .map(({ delivery }) => delivery);
};

/** The attempt still being worked on, or `null`. The latest one if, against the rules, there are two. */
export const openDeliveryOf = (order) => {
  const open = deliveriesOf(order).filter((delivery) => OPEN_DELIVERY_STATUSES.includes(statusOf(delivery.status)));
  return open.length > 0 ? open[open.length - 1] : null;
};

export const latestDeliveryOf = (order) => {
  const list = deliveriesOf(order);
  return list.length > 0 ? list[list.length - 1] : null;
};

/** The number the next attempt will carry: one past the highest so far, starting at 1. */
export const nextAttemptNo = (order) => deliveriesOf(order).reduce((max, delivery) => {
  const attempt = attemptOf(delivery);
  return attempt !== null && attempt > max ? attempt : max;
}, 0) + 1;

/**
 * May a delivery (or another attempt) be started for this order?
 *
 * The same rule `local_save_delivery` enforces in Rust — not deleted, Packed or Sent, nothing open —
 * plus one the screen adds: an order whose parcel already arrived does not get a second rider.
 *
 * @returns {{ok: boolean, message: string}} message is "" when ok
 */
export const canStartDelivery = (order) => {
  if (!order || typeof order !== "object" || !canonicalInventoryId(order.id)) {
    return { ok: false, message: "This order could not be read, so a delivery cannot be started for it." };
  }
  if (String(order.deleted_at ?? "").trim()) {
    return { ok: false, message: "This order was deleted." };
  }
  const status = String(order.status ?? "").trim().toUpperCase();
  if (status !== ORDER_STATUS.PACKED && status !== ORDER_STATUS.SENT) {
    if (status === ORDER_STATUS.RECEIVED) return { ok: false, message: "Pack the order first. A delivery starts once the parcel is ready." };
    if (status === ORDER_STATUS.DELIVERED) return { ok: false, message: "This order has already been delivered." };
    if (status === ORDER_STATUS.CANCELLED) return { ok: false, message: "This order was cancelled." };
    if (status === ORDER_STATUS.RETURNED) return { ok: false, message: "This order came back. Record a sale return before sending it again." };
    return { ok: false, message: `A delivery can only be started for a Packed or Sent order (this one is ${status || "blank"}).` };
  }
  const open = openDeliveryOf(order);
  if (open) {
    const attempt = attemptOf(open);
    const which = attempt === null ? "A delivery" : `Delivery attempt ${attempt}`;
    return {
      ok: false,
      message: `${which} is still ${labelOf(statusOf(open.status)).toLowerCase()}. Finish, cancel or fail it before starting another.`,
    };
  }
  const arrived = deliveriesOf(order).find((delivery) => [DELIVERY_STATUS.DELIVERED, DELIVERY_STATUS.CLOSED].includes(statusOf(delivery.status)));
  if (arrived) return { ok: false, message: "This order's parcel has already been delivered." };
  return { ok: true, message: "" };
};

/**
 * What a delivery move does to its order, for the screen to carry out with the order status command.
 *
 * - picked up while the order is Packed -> Send it (that is what creates the bill);
 * - delivered while the order is Sent  -> mark the order Delivered.
 *
 * Everything else leaves the order alone. In particular a failed attempt after pickup leaves the
 * order Sent — the bill exists and the stock has left — so a second rider can be booked.
 *
 * @returns {null | {orderTo: "SENT"} | {orderTo: "DELIVERED"}}
 */
export const orderEffectOfDeliveryMove = ({ order, to } = {}) => {
  const target = statusOf(to);
  const orderStatus = String(order?.status ?? "").trim().toUpperCase();
  if (target === DELIVERY_STATUS.PICKED_UP && orderStatus === ORDER_STATUS.PACKED) return { orderTo: ORDER_STATUS.SENT };
  if (target === DELIVERY_STATUS.DELIVERED && orderStatus === ORDER_STATUS.SENT) return { orderTo: ORDER_STATUS.DELIVERED };
  return null;
};
