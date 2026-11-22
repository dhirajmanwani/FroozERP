"use strict";

/**
 * Deliveries carried inside a customer order's sync record (Delivery module, 22 Nov 2026).
 *
 * ## Where they live
 *
 * A delivery (one Rapido/Uber/own-staff attempt, with its status history) belongs to one order and
 * travels inside that order's whole-record UPSERT as `payload.deliveries`. There is no separate
 * delivery entity type and no new sync road: the device bumps the order's version and queues the
 * whole order in the same transaction that writes a delivery change, and the cloud stores the array
 * in `customer_orders.deliveries` (JSONB) and republishes it with the order.
 *
 * ## Absent is not empty
 *
 * `undefined` or `null` means "this sender does not know about deliveries" -- an app version from
 * before the module, or an order that never had one. The handler then keeps what is stored
 * (`deliveries = COALESCE(EXCLUDED.deliveries, customer_orders.deliveries)`), so an old counter
 * editing an order can never wipe the deliveries a newer counter recorded. An array, including an
 * empty one, is the sender's whole truth and replaces what is stored.
 *
 * ## Refuse, by name, rather than guess
 *
 * Every rule here mirrors the shared contract (statuses, providers, paid_by, paise, the reason rule).
 * Anything that breaks one is answered `{ error }` naming the delivery and the field, which the
 * order handler turns into `rejectOperation(... "VALIDATION_ERROR", error)`. A throw would discard a
 * whole push batch, and a quietly dropped delivery would read as "never booked" on every other
 * device. Free-text fields are trimmed and length-capped instead of refused: a rider's note that is
 * too long is not a reason to stop the order reaching the other counters.
 *
 * Ids are opaque strings. Nothing here coerces one with Number(); they are compared trimmed.
 */

const DELIVERY_STATUSES = Object.freeze(["pending", "booked", "picked_up", "delivered", "closed", "cancelled", "failed"]);
const DELIVERY_PROVIDERS = Object.freeze(["rapido", "uber", "own_staff", "other"]);
const DELIVERY_PAID_BY = Object.freeze(["shop", "customer"]);
const REASON_REQUIRED_STATUSES = Object.freeze(["cancelled", "failed"]);

const MAX_DELIVERIES_PER_ORDER = 50;
const MAX_EVENTS_PER_DELIVERY = 50;
const MAX_ATTEMPT_NO = 1000;
const MAX_PAISE = 1e11;
const ID_MAX = 180;

/** Free-text fields and the length each is cut to. */
const TEXT_LIMITS = Object.freeze({
  customer_name: 220,
  customer_phone: 40,
  address: 1000,
  landmark: 300,
  area_name: 120,
  map_link: 1000,
  rider_name: 120,
  rider_phone: 40,
  tracking_link: 1000,
  booking_ref: 180,
  status_reason: 500,
  notes: 2000,
  created_by: 180,
});
const EVENT_TEXT_LIMITS = Object.freeze({ by_user: 180, note: 500 });

const TIMESTAMP_FIELDS = Object.freeze([
  "booked_at", "picked_up_at", "delivered_at", "closed_at", "cancelled_at", "failed_at", "created_at", "updated_at",
]);

/** The contract's delivery JSON, in its order. Anything else a device sends is not stored. */
const DELIVERY_FIELDS = Object.freeze([
  "id", "order_id", "attempt_no",
  "customer_name", "customer_phone", "address", "landmark", "area_name", "map_link",
  "provider", "rider_name", "rider_phone", "tracking_link", "booking_ref",
  "quoted_paise", "final_paise", "paid_by",
  "status", "status_reason",
  "booked_at", "picked_up_at", "delivered_at", "closed_at", "cancelled_at", "failed_at",
  "notes", "created_by", "created_at", "updated_at",
  "events",
]);

const isPresent = (value) => value !== null && value !== undefined && !(typeof value === "string" && value.trim() === "");

/** A trimmed opaque id, or "" when absent. A number is not an id here: "004" and 4 differ. */
const opaqueId = (value) => (typeof value === "string" ? value.trim() : "");

/** Trimmed, capped text or null. A non-string (other than absent) is a refusal. */
const cappedText = (value, limit) => {
  if (value === null || value === undefined) return { value: null };
  if (typeof value !== "string") return { error: true };
  const text = value.trim();
  return { value: text ? text.slice(0, limit) : null };
};

/** An ISO timestamp, null when absent, or a refusal when present and unparseable. */
const isoTimestamp = (value) => {
  if (!isPresent(value)) return { value: null };
  if (typeof value !== "string") return { error: true };
  const parsed = Date.parse(value.trim());
  if (!Number.isFinite(parsed)) return { error: true };
  return { value: new Date(parsed).toISOString() };
};

/**
 * Integer paise in 0..1e11, null when absent, or a refusal. Explicit checks, never `??`: zero
 * paise (a free delivery) is a real amount and must survive as 0.
 */
const paise = (value) => {
  if (!isPresent(value)) return { value: null };
  if (typeof value !== "number" && typeof value !== "string") return { error: true };
  const number = Number(value);
  if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || number > MAX_PAISE) return { error: true };
  return { value: number };
};

/** One of `allowed`, lower-cased; null when absent (only where `optional`); a refusal otherwise. */
const fromSet = (value, allowed, { optional = false } = {}) => {
  if (!isPresent(value)) return optional ? { value: null } : { error: true };
  if (typeof value !== "string") return { error: true };
  const text = value.trim().toLowerCase();
  return allowed.includes(text) ? { value: text } : { error: true };
};

const sanitizeEvents = (rawEvents, { deliveryId, label }) => {
  if (rawEvents === null || rawEvents === undefined) return { events: [] };
  if (!Array.isArray(rawEvents)) return { error: `${label} events must be a list` };
  if (rawEvents.length > MAX_EVENTS_PER_DELIVERY) {
    return { error: `${label} has more than ${MAX_EVENTS_PER_DELIVERY} events` };
  }
  const events = [];
  const seen = new Set();
  for (let index = 0; index < rawEvents.length; index += 1) {
    const raw = rawEvents[index];
    const eventLabel = `${label} event ${index + 1}`;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${eventLabel} is not an object` };
    const id = opaqueId(raw.id);
    if (!id || id.length > ID_MAX) return { error: `${eventLabel} is missing id` };
    if (seen.has(id)) return { error: `${eventLabel} repeats id ${id}` };
    seen.add(id);
    const ownerId = opaqueId(raw.delivery_id);
    if (ownerId && ownerId !== deliveryId) return { error: `${eventLabel} belongs to another delivery` };
    const from = fromSet(raw.from_status, DELIVERY_STATUSES, { optional: true });
    if (from.error) return { error: `${eventLabel} has an unsupported from_status` };
    const to = fromSet(raw.to_status, DELIVERY_STATUSES);
    if (to.error) return { error: `${eventLabel} has an unsupported to_status` };
    const at = isoTimestamp(raw.at);
    if (at.error || at.value === null) return { error: `${eventLabel} at is not a valid timestamp` };
    const byUser = cappedText(raw.by_user, EVENT_TEXT_LIMITS.by_user);
    if (byUser.error) return { error: `${eventLabel} by_user must be text` };
    const note = cappedText(raw.note, EVENT_TEXT_LIMITS.note);
    if (note.error) return { error: `${eventLabel} note must be text` };
    events.push({
      id,
      delivery_id: deliveryId,
      from_status: from.value,
      to_status: to.value,
      at: at.value,
      by_user: byUser.value,
      note: note.value,
    });
  }
  return { events };
};

const sanitizeDelivery = (raw, { orderId, label }) => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { error: `${label} is not an object` };
  const id = opaqueId(raw.id);
  if (!id) return { error: `${label} is missing id` };
  if (id.length > ID_MAX) return { error: `${label} id is too long` };
  const ownerOrder = opaqueId(raw.order_id);
  if (ownerOrder && orderId && ownerOrder !== orderId) return { error: `${label} belongs to another order` };

  const attemptValue = typeof raw.attempt_no === "number" || typeof raw.attempt_no === "string" ? Number(raw.attempt_no) : NaN;
  if (!Number.isInteger(attemptValue) || attemptValue < 1 || attemptValue > MAX_ATTEMPT_NO) {
    return { error: `${label} has an invalid attempt_no` };
  }

  const status = fromSet(raw.status, DELIVERY_STATUSES);
  if (status.error) return { error: `${label} has an unsupported status` };
  const provider = fromSet(raw.provider, DELIVERY_PROVIDERS, { optional: true });
  if (provider.error) return { error: `${label} has an unsupported provider` };
  const paidBy = fromSet(raw.paid_by, DELIVERY_PAID_BY, { optional: true });
  if (paidBy.error) return { error: `${label} has an unsupported paid_by` };

  const out = {
    id,
    order_id: orderId || ownerOrder || null,
    attempt_no: attemptValue,
  };
  for (const [field, limit] of Object.entries(TEXT_LIMITS)) {
    const text = cappedText(raw[field], limit);
    if (text.error) return { error: `${label} ${field} must be text` };
    out[field] = text.value;
  }
  for (const field of ["quoted_paise", "final_paise"]) {
    const amount = paise(raw[field]);
    if (amount.error) return { error: `${label} ${field} must be whole paise between 0 and ${MAX_PAISE}` };
    out[field] = amount.value;
  }
  for (const field of TIMESTAMP_FIELDS) {
    const stamp = isoTimestamp(raw[field]);
    if (stamp.error) return { error: `${label} ${field} is not a valid timestamp` };
    out[field] = stamp.value;
  }
  out.provider = provider.value;
  out.paid_by = paidBy.value;
  out.status = status.value;
  if (REASON_REQUIRED_STATUSES.includes(out.status) && !out.status_reason) {
    return { error: `${label} is ${out.status} without a reason` };
  }

  const events = sanitizeEvents(raw.events, { deliveryId: id, label });
  if (events.error) return { error: events.error };
  out.events = events.events;

  // The contract's field order, so every stored and published delivery reads the same.
  const ordered = {};
  for (const field of DELIVERY_FIELDS) ordered[field] = out[field] === undefined ? null : out[field];
  return { delivery: ordered };
};

/**
 * Sanitise `payload.deliveries` of a customer order push.
 *
 * @param {unknown} rawDeliveries the payload's `deliveries`
 * @param {{ orderId?: string }} options the order's entity id; a delivery naming a different order is refused
 * @returns {{ value: null }} absent: keep what is stored
 *        | {{ value: object[] }} the deliveries to store, in attempt order
 *        | {{ error: string }} a named reason for `rejectOperation`
 */
const sanitizeOrderDeliveries = (rawDeliveries, { orderId = "" } = {}) => {
  if (rawDeliveries === null || rawDeliveries === undefined) return { value: null };
  if (!Array.isArray(rawDeliveries)) return { error: "Customer order deliveries must be a list" };
  if (rawDeliveries.length > MAX_DELIVERIES_PER_ORDER) {
    return { error: `Customer order has more than ${MAX_DELIVERIES_PER_ORDER} deliveries` };
  }
  const order = opaqueId(orderId);
  const deliveries = [];
  const ids = new Set();
  const attempts = new Set();
  for (let index = 0; index < rawDeliveries.length; index += 1) {
    const label = `delivery ${index + 1}`;
    const result = sanitizeDelivery(rawDeliveries[index], { orderId: order, label });
    if (result.error) return { error: result.error };
    const { delivery } = result;
    if (ids.has(delivery.id)) return { error: `${label} repeats id ${delivery.id}` };
    if (attempts.has(delivery.attempt_no)) return { error: `${label} repeats attempt_no ${delivery.attempt_no}` };
    ids.add(delivery.id);
    attempts.add(delivery.attempt_no);
    deliveries.push(delivery);
  }
  deliveries.sort((left, right) => left.attempt_no - right.attempt_no);
  return { value: deliveries };
};

module.exports = {
  DELIVERY_STATUSES,
  DELIVERY_PROVIDERS,
  DELIVERY_PAID_BY,
  REASON_REQUIRED_STATUSES,
  DELIVERY_FIELDS,
  MAX_DELIVERIES_PER_ORDER,
  MAX_EVENTS_PER_DELIVERY,
  MAX_PAISE,
  sanitizeOrderDeliveries,
};
