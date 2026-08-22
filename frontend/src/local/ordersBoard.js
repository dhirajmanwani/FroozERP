/**
 * The Orders screen, decided here rather than in the component.
 *
 * `orderLifecycle.js` owns the rules — which move follows which, when a reservation lapses.
 * This turns those rules into what a person sees: which column an order sits in, which buttons it
 * offers, and what it must say about itself. Splitting them keeps the rules testable without a
 * browser and keeps the component free of judgement calls.
 *
 * The rule that shapes it: **an order must never present a button that will be refused.** Offering
 * "Send" on an order whose stock lapsed an hour ago, and only then explaining, teaches an operator
 * that the app's buttons are suggestions. Every action listed here is one the lifecycle will accept.
 */

import {
  ORDER_STATUS,
  RESERVATION_STATE,
  canTransition,
  nextStatuses,
  paymentBlocksSending,
  reservationState,
} from "./orderLifecycle.js";

export const ORDER_BOARD_COLUMNS = Object.freeze([
  { key: ORDER_STATUS.RECEIVED, label: "Received", hint: "Stock is set aside for these." },
  { key: ORDER_STATUS.PACKED, label: "Packed", hint: "Boxed and waiting to go out." },
  { key: ORDER_STATUS.SENT, label: "Sent", hint: "On its way. Billed." },
]);

/** Actions offered per status, in the order a person works through them. */
const ACTION_LABELS = Object.freeze({
  [ORDER_STATUS.PACKED]: { label: "Mark packed", tone: "primary" },
  [ORDER_STATUS.SENT]: { label: "Send", tone: "primary", needsCarrier: true },
  [ORDER_STATUS.DELIVERED]: { label: "Mark delivered", tone: "primary" },
  [ORDER_STATUS.RECEIVED]: { label: "Back to received", tone: "quiet" },
  [ORDER_STATUS.CANCELLED]: { label: "Cancel order", tone: "danger", needsReason: true },
  [ORDER_STATUS.RETURNED]: { label: "Came back", tone: "danger" },
});

const money = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
};

/** What the customer was quoted, which is not necessarily today's counter rate. */
export const orderValue = (order) =>
  (Array.isArray(order?.items) ? order.items : []).reduce(
    (total, line) => total + money(line?.quantity) * money(line?.agreed_rate),
    0,
  );

/**
 * One order, ready to render.
 *
 * `warning` is the load-bearing field. A lapsed order looks exactly like a fresh one — same
 * customer, same lines, same column — and the only difference is that its fruit went back on the
 * shelf and may since have been sold to somebody else.
 */
export const presentOrder = (order, nowMs = Date.now()) => {
  // Whatever the row actually says, including nothing. Defaulting a missing status to RECEIVED
  // invents a fact about a corrupt row and presents it as a live order holding stock — the row is
  // then indistinguishable from a real one, which is the opposite of what a reader needs.
  const status = order?.status || "";
  const reservation = reservationState(order, nowMs);
  const lapsed = reservation === RESERVATION_STATE.LAPSED;
  return {
    id: order?.id ?? null,
    orderNo: order?.order_no || "",
    customerName: order?.customer_name || "Walk-in customer",
    customerMobile: order?.customer_mobile || "",
    // Carried through so a bill raised from this order reaches the right ledger. Nullable on the
    // order by design — a first-time caller has no customer record — so it is passed as-is and the
    // bill falls back to a walk-in only when there genuinely is nobody to bill.
    customerId: order?.customer_id || "",
    deliveryAddress: order?.delivery_address || "",
    source: order?.source || "PHONE",
    status,
    reservation,
    items: Array.isArray(order?.items) ? order.items : [],
    value: orderValue(order),
    paymentState: order?.payment_state || null,
    amountPaid: Number(order?.amount_paid) || 0,
    paymentReference: order?.payment_reference || "",
    // Empty when the money question is settled. Drives whether Send is offered at all.
    paymentWarning: paymentBlocksSending(order),
    carrier: order?.carrier || "",
    carrierReference: order?.carrier_reference || "",
    trackingUrl: order?.tracking_url || "",
    invoiceNo: order?.invoice_no || "",
    billed: Boolean(String(order?.sale_id || "").trim()),
    warning: lapsed
      ? "The stock held for this order went back on the shelf after six hours. Check it is still in the shop before packing."
      : "",
    actions: nextStatuses(status)
      .map((next) => ({ to: next, ...ACTION_LABELS[next] }))
      .filter((action) => Boolean(action.label))
      // Send disappears until the money question is answered rather than appearing and refusing.
      // Every action this board offers is one the lifecycle accepts; a button that argues back is
      // how an operator learns to stop reading the messages.
      .filter((action) => !(action.to === ORDER_STATUS.SENT && paymentBlocksSending(order))),
  };
};

/**
 * The board: three working columns, plus everything finished.
 *
 * Delivered, cancelled and returned orders are kept rather than hidden. A board that dropped an
 * order the moment it finished would make "did that actually go out?" unanswerable the next
 * morning, which is the question this module exists to answer.
 */
export const buildOrdersBoard = (orders = [], nowMs = Date.now()) => {
  const presented = (Array.isArray(orders) ? orders : []).map((order) => presentOrder(order, nowMs));
  const columns = ORDER_BOARD_COLUMNS.map((column) => ({
    ...column,
    orders: presented.filter((order) => order.status === column.key),
  }));
  const finished = presented.filter((order) => [
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.RETURNED,
  ].includes(order.status));
  // Anything whose status this app does not know about. It belongs nowhere on the board and would
  // otherwise be counted in no total and drawn in no column — an order that simply is not there,
  // with nothing to say it was dropped. The database refuses such a status, so reaching here means
  // something outside the app wrote it, which is precisely when silence is worst.
  const known = [...Object.values(ORDER_STATUS)];
  const unknown = presented.filter((order) => !known.includes(order.status));
  const needsAttention = [
    ...presented.filter((order) => order.warning),
    ...unknown.map((order) => ({
      ...order,
      warning: `This order has an unrecognised status (${order.status || "blank"}) and cannot be worked on here.`,
    })),
  ];
  return {
    columns,
    finished,
    unknown,
    needsAttention,
    openCount: columns.reduce((total, column) => total + column.orders.length, 0),
    reservedValue: columns
      .filter((column) => column.key !== ORDER_STATUS.SENT)
      .reduce((total, column) => total + column.orders.reduce((sum, order) => sum + order.value, 0), 0),
  };
};

/**
 * Whether a move may be attempted, and what to say if not.
 *
 * Sending requires a carrier: an order marked sent with no record of who took it is a parcel the
 * shop cannot answer a question about, and the customer's only question is where it is.
 */
export const validateOrderAction = ({ order, to, carrier = "", reason = "" } = {}) => {
  const from = order?.status;
  if (!canTransition(from, to)) {
    return { ok: false, message: `This order cannot go from ${from} to ${to}.` };
  }
  if (to === ORDER_STATUS.SENT) {
    // Money before goods. Asked here as well as shown on the card, so the answer cannot be skipped
    // by a caller that did not draw the card.
    const unpaid = paymentBlocksSending(order);
    if (unpaid) return { ok: false, message: unpaid };
    if (!String(carrier || "").trim()) {
      return { ok: false, message: "Enter who is carrying this order before marking it sent." };
    }
  }
  if (to === ORDER_STATUS.CANCELLED && !String(reason || "").trim()) {
    return { ok: false, message: "Give a reason for cancelling, so the customer can be told why." };
  }
  return { ok: true, message: "" };
};
