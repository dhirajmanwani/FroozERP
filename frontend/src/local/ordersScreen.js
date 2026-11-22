/**
 * The Orders screen's compact cards, decided here rather than in App.jsx.
 *
 * The owner, 22 Nov 2026: "bht taam jaam he ... premium and sophisticated aur bhai simple rakho".
 * Every card used to carry the payment select, an items table, a carrier box, the delivery panel and
 * up to four buttons. Now a card says who, what, how much, whether it is paid, how long it has
 * waited, and the ONE next step; everything else moved into the order's detail drawer.
 *
 * Nothing here decides which moves are legal: `ordersBoard.js` (`presentOrder().actions`) and the
 * lifecycle do, and the one step offered is always one of those actions, or "open the order" when
 * the step needs an answer first (who is carrying it, has it been paid).
 */

import { counterQuantityWithUnit } from "./counterScreens.js";
import { ORDER_STATUS } from "./orderLifecycle.js";

const rows = (value) => (Array.isArray(value) ? value : []);
const text = (value) => (value === null || value === undefined ? "" : String(value)).trim();

/** "Apple 2 Kg, Kiwi 6 Piece +2 more": the order in one line. */
export const orderItemSummary = (items = [], max = 2) => {
  const lines = rows(items);
  if (lines.length === 0) return "No items recorded";
  const shown = lines.slice(0, max).map((line) => {
    const quantity = counterQuantityWithUnit(line?.quantity, line?.unit);
    return `${text(line?.product_name) || "Item"} ${quantity}`;
  });
  const more = lines.length - shown.length;
  return `${shown.join(", ")}${more > 0 ? ` +${more} more` : ""}`;
};

const timeOf = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

/** "just now", "12 min", "3 h", "2 d"; "" when the order carries no usable time. */
export const orderAgeLabel = (createdAt, nowMs = Date.now()) => {
  const at = timeOf(createdAt);
  if (at === null) return "";
  const minutes = Math.max(0, Math.floor((nowMs - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h`;
  return `${Math.floor(hours / 24)} d`;
};

export const PAYMENT_CHIP = Object.freeze({
  PAID: { label: "Paid", tone: "positive" },
  ON_DELIVERY: { label: "Pay on delivery", tone: "neutral" },
  UNPAID: { label: "Not paid", tone: "attention" },
  UNDECIDED: { label: "Payment?", tone: "attention" },
});

/** The small payment chip on a card. An unanswered question is a question, never "Paid". */
export const orderPaymentChip = (paymentState) => PAYMENT_CHIP[text(paymentState).toUpperCase()] || PAYMENT_CHIP.UNDECIDED;

export const NEXT_STEP_KIND = Object.freeze({
  /** Run this lifecycle move straight from the card. */
  MOVE: "move",
  /** Open the order: the step needs an answer the card does not hold. */
  OPEN: "open",
  NONE: "none",
});

/**
 * The one button a card shows.
 *
 * `order` is `presentOrder`'s shape. `delivery` is `{ open, canStart }` for the stored order: whether
 * a delivery attempt is in flight, and whether one may be booked now.
 *
 * - Received → Pack (a move; packing asks nothing).
 * - Packed → Record payment when the money question is open (Send is withheld until it is answered);
 *   Track delivery while a rider has it; otherwise Book delivery or Send, which opens the order,
 *   because sending needs to know who is carrying it.
 * - Sent → Delivered (a move).
 */
export const orderNextStep = (order, { open = false, canStart = false } = {}) => {
  const actions = rows(order?.actions);
  const find = (to) => actions.find((action) => action?.to === to);
  const status = text(order?.status);
  if (status === ORDER_STATUS.RECEIVED && find(ORDER_STATUS.PACKED)) {
    return { kind: NEXT_STEP_KIND.MOVE, to: ORDER_STATUS.PACKED, label: "Pack", action: find(ORDER_STATUS.PACKED) };
  }
  if (status === ORDER_STATUS.PACKED) {
    if (order?.paymentWarning) return { kind: NEXT_STEP_KIND.OPEN, focus: "payment", label: "Record payment" };
    if (open) return { kind: NEXT_STEP_KIND.OPEN, focus: "delivery", label: "Track delivery" };
    if (canStart) return { kind: NEXT_STEP_KIND.OPEN, focus: "delivery", label: "Book delivery" };
    if (find(ORDER_STATUS.SENT)) return { kind: NEXT_STEP_KIND.OPEN, focus: "send", label: "Send" };
  }
  if (status === ORDER_STATUS.SENT) {
    if (open) return { kind: NEXT_STEP_KIND.OPEN, focus: "delivery", label: "Track delivery" };
    if (find(ORDER_STATUS.DELIVERED)) {
      return { kind: NEXT_STEP_KIND.MOVE, to: ORDER_STATUS.DELIVERED, label: "Delivered", action: find(ORDER_STATUS.DELIVERED) };
    }
  }
  return { kind: NEXT_STEP_KIND.NONE, label: "" };
};

const FINISHED = [ORDER_STATUS.DELIVERED, ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED];

/** When a finished order finished: the stamp of its last move, else its last change. */
export const finishedAt = (raw) => {
  const status = text(raw?.status).toUpperCase();
  const stamp = status === ORDER_STATUS.DELIVERED ? raw?.delivered_at
    : status === ORDER_STATUS.CANCELLED ? raw?.cancelled_at
      : raw?.returned_at;
  return timeOf(stamp) ?? timeOf(raw?.updated_at);
};

const dayKey = (ms) => {
  const date = new Date(ms);
  return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
};

/**
 * Finished orders, split into today's and earlier ones.
 *
 * `finished` is `buildOrdersBoard().finished`; `rawById` maps canonical id to the stored order,
 * which carries the timestamps. An order with no readable time counts as earlier rather than
 * vanishing: the history stays reachable either way.
 */
export const splitFinishedToday = (finished = [], rawById = new Map(), nowMs = Date.now(), idOf = (value) => text(value)) => {
  const today = [];
  const earlier = [];
  const todayKey = dayKey(nowMs);
  for (const order of rows(finished)) {
    if (!FINISHED.includes(order?.status)) continue;
    const at = finishedAt(rawById.get(idOf(order?.id)));
    (at !== null && dayKey(at) === todayKey ? today : earlier).push(order);
  }
  return { today, earlier };
};

/** The count chips in the header: only the ones with something in them, plus needs-checking. */
export const orderCountChips = (board) => {
  const columns = rows(board?.columns);
  const count = (key) => rows(columns.find((column) => column.key === key)?.orders).length;
  const chips = [
    { key: ORDER_STATUS.RECEIVED, label: "New", count: count(ORDER_STATUS.RECEIVED), tone: "neutral" },
    { key: ORDER_STATUS.PACKED, label: "Packed", count: count(ORDER_STATUS.PACKED), tone: "neutral" },
    { key: ORDER_STATUS.SENT, label: "Out for delivery", count: count(ORDER_STATUS.SENT), tone: "neutral" },
  ];
  const checking = rows(board?.needsAttention).length;
  if (checking > 0) chips.push({ key: "CHECK", label: "Needs checking", count: checking, tone: "attention" });
  return chips;
};

/** The board's column names as the owner reads them. */
export const ORDER_COLUMN_LABEL = Object.freeze({
  [ORDER_STATUS.RECEIVED]: "New",
  [ORDER_STATUS.PACKED]: "Packed",
  [ORDER_STATUS.SENT]: "Out for delivery",
});
