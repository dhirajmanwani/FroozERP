/**
 * The orders that are worth interrupting somebody for.
 *
 * The Orders screen shows every order; this decides which of them is a *task*. The maintainer asked
 * for exactly one thing on 2026-08-22: "when I get an order the app should ask me first if the bill
 * amount is paid before sending the parcel" — so the money question is the loudest item here, and it
 * is the only one that can be an error about something the shop is about to do rather than about
 * something it has already let slip.
 *
 * `orderLifecycle.js` owns the rules (what blocks a parcel, when a hold lapses) and `ordersBoard.js`
 * turns them into columns. This turns the same rules into the bell: a short list, worst first, each
 * line naming the next action. It is pure — no timers, no `Date.now()`, no React — because the bell
 * re-runs it every few seconds and a clock read inside would make the behaviour untestable, which is
 * a bug this repo has already paid for once.
 *
 * ## Why every item carries a stable key
 *
 * Re-running this on a ticker must not produce a stream of new rows. `notificationCenter.js`
 * collapses repeats on `dedupeKey`, so an item's key is built from the order and the kind of alert
 * and from nothing else — not from the time, not from the severity. An order that sits and gets
 * worse then *upgrades* its existing row (the centre never lets severity decay) instead of adding a
 * second one, which is the behaviour a person watching the bell expects.
 *
 * ## Why a bad list is louder than an empty one
 *
 * If the orders cannot be read, this returns one error item saying so rather than an empty list. An
 * empty bell reads as "nothing needs you", and telling the owner that while unpaid parcels are going
 * out is the `CLAUDE.md` rule about errors never rendering as zero, in its most expensive form.
 */

import {
  ORDER_STATUS,
  RESERVATION_STATE,
  RESERVATION_TTL_MS,
  paymentBlocksSending,
  reservationState,
} from "./orderLifecycle.js";
import { NOTIFICATION_SEVERITY } from "./notificationCenter.js";
import { canonicalInventoryId } from "./stockInventory.js";

/** What the bell can be telling you about an order. Part of the dedupe key, so these strings are stored. */
export const ORDER_ALERT_KIND = Object.freeze({
  PAYMENT_BEFORE_SENDING: "PAYMENT_BEFORE_SENDING",
  RESERVATION_LAPSED: "RESERVATION_LAPSED",
  RESERVATION_EXPIRING: "RESERVATION_EXPIRING",
  ORDER_UNTOUCHED: "ORDER_UNTOUCHED",
  ORDERS_UNREADABLE: "ORDERS_UNREADABLE",
});

/** Shown as the notification's source, so a bell row says where it came from. */
export const ORDER_ALERT_SOURCE = "Orders";

/**
 * How long a new order may sit before the bell says something, and how the tone hardens.
 *
 * Fifteen minutes, because an order that arrived two minutes ago is already in front of whoever
 * took it, and shouting then teaches people to ignore the bell. One hour, because by then the
 * person who took the order has moved on to something else and it is genuinely forgotten. Three
 * hours, because that is half the {@link RESERVATION_TTL_MS} hold — past that point the order is not
 * merely late, it is on its way to losing the stock that is being kept for it.
 */
export const UNTOUCHED_ORDER_STEPS_MS = Object.freeze([
  Object.freeze({ afterMs: 15 * 60 * 1000, severity: NOTIFICATION_SEVERITY.INFO }),
  Object.freeze({ afterMs: 60 * 60 * 1000, severity: NOTIFICATION_SEVERITY.WARNING }),
  Object.freeze({ afterMs: 3 * 60 * 60 * 1000, severity: NOTIFICATION_SEVERITY.ERROR }),
]);

/**
 * How far ahead of a lapse the warning comes.
 *
 * One hour of the six-hour hold. Enough time to pack an order and keep the fruit set aside, and late
 * enough that it is a real deadline: warning at three hours would put every ordinary morning order
 * on the list and quietly turn a six-hour hold into a three-hour one.
 */
export const RESERVATION_EXPIRY_WARNING_MS = 60 * 60 * 1000;

/**
 * Which alert wins when two are equally severe.
 *
 * Payment first, and deliberately above a lapsed reservation even though both are errors: a lapsed
 * hold is money the shop might still recover by ringing the customer, while a parcel that leaves
 * unpaid is money already gone. Once the goods are in a stranger's hands there is no leverage left.
 */
const KIND_ORDER = Object.freeze({
  [ORDER_ALERT_KIND.ORDERS_UNREADABLE]: 0,
  [ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING]: 1,
  [ORDER_ALERT_KIND.RESERVATION_LAPSED]: 2,
  [ORDER_ALERT_KIND.RESERVATION_EXPIRING]: 3,
  [ORDER_ALERT_KIND.ORDER_UNTOUCHED]: 4,
});

const SEVERITY_ORDER = Object.freeze({
  [NOTIFICATION_SEVERITY.ERROR]: 3,
  [NOTIFICATION_SEVERITY.WARNING]: 2,
  [NOTIFICATION_SEVERITY.INFO]: 1,
  [NOTIFICATION_SEVERITY.SUCCESS]: 0,
});

/** Finished orders are history, not work. Nothing here fires for them. */
const CLOSED_STATUSES = Object.freeze([
  ORDER_STATUS.SENT,
  ORDER_STATUS.DELIVERED,
  ORDER_STATUS.CANCELLED,
  ORDER_STATUS.RETURNED,
]);

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * A timestamp from a device, in whichever shape it arrived: epoch number, ISO string, `Date`, or
 * missing. Returns `null` when there is no usable time — never a guess, because a guessed arrival
 * time turns into a guessed age and then into an alert nobody can act on.
 */
const asTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * The first field that actually carries a time.
 *
 * Written as a loop over `asTime` rather than `a ?? b ?? c` on purpose: `??` only falls through on
 * `null`/`undefined`, so a field holding `0`, `""` or the string "not a date" would be accepted and
 * a later, perfectly good field ignored. `CLAUDE.md` names this exact trap.
 */
const firstTime = (values) => {
  for (const value of values) {
    const parsed = asTime(value);
    if (parsed !== null) return parsed;
  }
  return null;
};

/**
 * A reading copy with the status and payment answer in the case the rest of the app uses.
 *
 * A device that hands over `"packed"` would otherwise be treated as an unknown status: no payment
 * question asked, no hold tracked, and the order silently absent from this list. The copy is only
 * ever read from — nothing here writes a normalised value back to the caller's order.
 */
const normalizeOrder = (order) => {
  const paymentState = text(order?.payment_state).toUpperCase();
  return {
    ...order,
    status: text(order?.status).toUpperCase(),
    payment_state: paymentState || null,
  };
};

/**
 * The order's identity, as an opaque string.
 *
 * `"004"` and `4` are different orders and must never collapse into one bell row, so ids are trimmed
 * and never coerced with `Number()`. An order carrying no id at all falls back to its order number,
 * and then to its position — a positional key is weak, but it is stable within a run and beats
 * merging two unidentifiable orders into a single alert.
 */
const orderKey = (order, index) => (
  canonicalInventoryId(order?.id)
  || canonicalInventoryId(order?.order_no)
  || `row-${index}`
);

/** What to call this order in a sentence the owner reads. */
const orderLabel = (order) => {
  const orderNo = text(order?.order_no);
  if (orderNo) return `Order ${orderNo}`;
  const id = canonicalInventoryId(order?.id);
  return id ? `Order #${id}` : "An order";
};

const customerLabel = (order) => text(order?.customer_name) || "a walk-in customer";

/** A gap in words. Whole units only — "2 hours 15 minutes" is read faster than "2.25 hours". */
const describeGap = (ms) => {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  const hoursText = `${hours} hour${hours === 1 ? "" : "s"}`;
  return rest === 0 ? hoursText : `${hoursText} ${rest} minute${rest === 1 ? "" : "s"}`;
};

/** The length of the hold, in words, taken from the constant so the sentence cannot go stale. */
const HOLD_TEXT = describeGap(RESERVATION_TTL_MS);

/**
 * The key a repeat collapses onto, and the id of the row.
 *
 * Exported so the screen can retract an item with `resolveNotification` once the owner has dealt
 * with it — a payment taken should clear its own row, not sit there implying it is still a problem.
 */
export const orderAlertKey = (kind, orderIdOrKey) => `orders:${kind}:${canonicalInventoryId(orderIdOrKey)}`;

/**
 * Conditions that stay true until a person does something, and where staying quiet costs money.
 * Sticky entries survive "clear all", so clearing the bell cannot hide an unpaid parcel or stock
 * that has already gone back on the shelf.
 */
const STICKY_KINDS = Object.freeze([
  ORDER_ALERT_KIND.ORDERS_UNREADABLE,
  ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING,
  ORDER_ALERT_KIND.RESERVATION_LAPSED,
]);

const buildAlert = ({ kind, key, severity, title, message, at, orderId, ageMs = 0 }) => ({
  id: orderAlertKey(kind, key),
  dedupeKey: orderAlertKey(kind, key),
  severity,
  title,
  message,
  source: ORDER_ALERT_SOURCE,
  at,
  sticky: STICKY_KINDS.includes(kind),
  // Carried for the screen, and used as sort keys. `notificationCenter.createNotification` reads
  // only the fields above and ignores these, so an item can be passed to it unchanged.
  kind,
  orderId: orderId ?? null,
  ageMs,
});

/** The severity a new order has earned by sitting this long, or `null` while it is still fresh. */
const untouchedSeverity = (ageMs) => {
  let severity = null;
  for (const step of UNTOUCHED_ORDER_STEPS_MS) {
    if (ageMs >= step.afterMs) severity = step.severity;
  }
  return severity;
};

const alertsForOrder = (rawOrder, index, nowMs, at) => {
  const order = normalizeOrder(rawOrder);
  const key = orderKey(rawOrder, index);
  const orderId = rawOrder?.id ?? null;
  const label = orderLabel(rawOrder);
  const alerts = [];

  // A finished order is not a task. Sent, delivered, cancelled and returned orders drop out here,
  // which is also why nothing below has to re-check them.
  if (CLOSED_STATUSES.includes(order.status)) return alerts;
  if (order.status !== ORDER_STATUS.RECEIVED && order.status !== ORDER_STATUS.PACKED) return alerts;

  // (2) The one the owner asked for. `paymentBlocksSending` already decides this and already speaks
  // plain English, so its sentence is used as the message rather than a second opinion written here.
  if (order.status === ORDER_STATUS.PACKED) {
    const blocked = paymentBlocksSending(order);
    if (blocked) {
      alerts.push(buildAlert({
        kind: ORDER_ALERT_KIND.PAYMENT_BEFORE_SENDING,
        key,
        orderId,
        severity: NOTIFICATION_SEVERITY.ERROR,
        title: `${label} is packed but not paid for`,
        message: `${blocked} It is for ${customerLabel(rawOrder)}.`,
        at,
      }));
    }
  }

  const reservation = reservationState(order, nowMs);
  const heldSince = firstTime([rawOrder?.reserved_at, rawOrder?.created_at]);

  // (4) The hold is gone. Worse than (3) because the fruit is back on the shelf and may already have
  // been sold to whoever walked in, while the customer is still expecting it.
  if (reservation === RESERVATION_STATE.LAPSED) {
    const overdueMs = heldSince === null ? 0 : Math.max(0, nowMs - heldSince - RESERVATION_TTL_MS);
    alerts.push(buildAlert({
      kind: ORDER_ALERT_KIND.RESERVATION_LAPSED,
      key,
      orderId,
      severity: NOTIFICATION_SEVERITY.ERROR,
      title: `${label} lost the stock being held for it`,
      message: `The fruit set aside for ${customerLabel(rawOrder)} went back on the shelf after ${HOLD_TEXT}. Check it is still in the shop before packing, and ring the customer if it is not.`,
      at,
      ageMs: overdueMs,
    }));
  }

  // (3) The hold is about to go. Said before it happens, because afterwards the only honest message
  // is the one above. Packing keeps the hold, so there is a real action to offer.
  if (reservation === RESERVATION_STATE.ACTIVE && order.status === ORDER_STATUS.RECEIVED && heldSince !== null) {
    const leftMs = heldSince + RESERVATION_TTL_MS - nowMs;
    if (leftMs > 0 && leftMs <= RESERVATION_EXPIRY_WARNING_MS) {
      alerts.push(buildAlert({
        kind: ORDER_ALERT_KIND.RESERVATION_EXPIRING,
        key,
        orderId,
        severity: NOTIFICATION_SEVERITY.WARNING,
        title: `${label} loses its stock in ${describeGap(leftMs)}`,
        message: `The fruit set aside for ${customerLabel(rawOrder)} goes back on the shelf in ${describeGap(leftMs)}. Pack the order now to keep it.`,
        at,
        ageMs: RESERVATION_EXPIRY_WARNING_MS - leftMs,
      }));
    }
  }

  // (1) Nobody has started it. Only for RECEIVED: once an order is packed somebody has plainly
  // touched it. Suppressed when the hold has already lapsed, because (4) is the same order with a
  // worse story and a different instruction — two rows would be one problem shouted twice.
  if (order.status === ORDER_STATUS.RECEIVED && reservation !== RESERVATION_STATE.LAPSED) {
    const arrivedAt = firstTime([rawOrder?.received_at, rawOrder?.created_at, rawOrder?.ordered_at, rawOrder?.reserved_at]);
    if (arrivedAt === null) {
      // No time on the row at all, so there is no telling whether it arrived a minute or a week ago.
      // Kept quiet would be a promise that it is fresh, and nothing here knows that.
      alerts.push(buildAlert({
        kind: ORDER_ALERT_KIND.ORDER_UNTOUCHED,
        key,
        orderId,
        severity: NOTIFICATION_SEVERITY.INFO,
        title: `${label} is waiting, with no time on it`,
        message: `This order carries no arrival time, so there is no telling how long ${customerLabel(rawOrder)} has been waiting. Open it and check.`,
        at,
      }));
    } else {
      const ageMs = Math.max(0, nowMs - arrivedAt);
      const severity = untouchedSeverity(ageMs);
      if (severity) {
        alerts.push(buildAlert({
          kind: ORDER_ALERT_KIND.ORDER_UNTOUCHED,
          key,
          orderId,
          severity,
          title: `${label} has been waiting ${describeGap(ageMs)}`,
          message: `${customerLabel(rawOrder)} placed this ${describeGap(ageMs)} ago and nobody has started it. Pack it, or ring the customer if it cannot go today.`,
          at,
          ageMs,
        }));
      }
    }
  }

  return alerts;
};

/**
 * Worst first, and the same order every time.
 *
 * Severity decides first, then the kind (see {@link KIND_ORDER} — payment beats everything else at
 * the same severity), then the longer-standing problem, and finally the dedupe key as a plain string
 * compare. That last step is what makes the sort total: two orders that match on every other key
 * still cannot swap places between runs, so the bell does not reshuffle itself while being read.
 */
const compareAlerts = (left, right) => (
  (SEVERITY_ORDER[right.severity] ?? 0) - (SEVERITY_ORDER[left.severity] ?? 0)
  || (KIND_ORDER[left.kind] ?? 99) - (KIND_ORDER[right.kind] ?? 99)
  || right.ageMs - left.ageMs
  || (left.dedupeKey < right.dedupeKey ? -1 : left.dedupeKey > right.dedupeKey ? 1 : 0)
);

const unreadableAlert = (at, message) => [buildAlert({
  kind: ORDER_ALERT_KIND.ORDERS_UNREADABLE,
  key: "all",
  severity: NOTIFICATION_SEVERITY.ERROR,
  title: "Orders could not be read",
  message,
  at,
})];

/**
 * The bell's order list: every order that needs a person, worst first.
 *
 * `nowMs` is required rather than defaulted to `Date.now()`, so the same input always produces the
 * same output — the local suites were fixed once already for depending on the host's clock, and this
 * module escalates on time, which is exactly the thing that goes untested when a clock hides inside.
 *
 * @param {Array<object>} orders raw order rows, as the snapshot or the API hands them over
 * @param {number} nowMs current time in epoch milliseconds
 * @returns {Array<object>} items ready for `createNotification` in `notificationCenter.js`
 */
export const buildOrderNotifications = (orders, nowMs) => {
  const stamp = asTime(nowMs);
  if (stamp === null) {
    // Without a clock, "two hours ago" and "in five minutes" are both unsayable. Refusing loudly is
    // the only honest answer; an empty list would read as "no orders need you".
    return unreadableAlert(new Date(0).toISOString(), "The app could not read the current time, so orders cannot be checked for payment or for stock being held. Close and reopen the Orders screen.");
  }
  const at = new Date(stamp).toISOString();
  if (!Array.isArray(orders)) {
    return unreadableAlert(at, "The order list could not be read, so this app cannot tell you which orders need paying for or packing. Reopen the Orders screen, and restart the app if it stays empty.");
  }

  return orders
    .flatMap((order, index) => alertsForOrder(order, index, stamp, at))
    .sort(compareAlerts);
};
