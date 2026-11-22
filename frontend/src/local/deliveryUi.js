/**
 * The small decisions the Delivery screens make, kept out of App.jsx so they can be tested.
 *
 * The rules themselves live elsewhere: legal moves, money and ages in `deliveryLifecycle.js`, the
 * texts in `deliveryText.js`, the settings shape in `deliverySettings.js`. This file only turns them
 * into what a screen needs: a prefilled form, a payload to save, the plan for one button press, the
 * cards of the Deliveries board, the delivery charge to put on a bill, and the sales per day the
 * delivery reports divide by.
 *
 * Pure: no clock read inside (`nowMs` is passed in), no React, no I/O.
 */

import {
  DELIVERY_STATUS,
  DELIVERY_STATUS_LABEL,
  PAID_BY,
  REASON_REQUIRED_STATUSES,
  TERMINAL_DELIVERY_STATUSES,
  closingFinalPaise,
  deliveriesOf,
  deliveryChargePaise,
  isDeliveryOverdue,
  minutesInStatus,
  orderEffectOfDeliveryMove,
  paiseToRupees,
  rupeesToPaise,
  validateDeliveryMove,
} from "./deliveryLifecycle.js";
import { PROVIDER_LABEL } from "./deliveryProviders.js";
import { usualChargeForArea } from "./deliverySettings.js";
import { ORDER_STATUS } from "./orderLifecycle.js";
import { shopDateKey } from "./orderReporting.js";
import { canonicalInventoryId } from "./stockInventory.js";

const clean = (value) => String(value ?? "").trim();
const statusOf = (value) => clean(value).toLowerCase();

/** "Rs 60" or "Rs 72.50". */
export const formatRupees = (rupees) => {
  const value = Number(rupees);
  if (!Number.isFinite(value)) return "";
  return `Rs ${Number.isInteger(value) ? value.toLocaleString("en-IN") : value.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

/** Paise as the text a form box holds: "" for no amount, never "0" for one. */
export const paiseToInput = (paise) => {
  const rupees = paiseToRupees(paise);
  return rupees === null ? "" : String(rupees);
};

/** The one sentence said when the order was sent but its delivery could not be moved. */
export const DELIVERY_SENT_BUT_NOT_PICKED_UP =
  "Order sent and billed, but the delivery was not marked picked up — press Picked up again.";

/** Providers in the order the form lists them. */
export const DELIVERY_PROVIDER_IDS = Object.freeze(Object.keys(PROVIDER_LABEL));

export const providerLabel = (provider) => PROVIDER_LABEL[statusOf(provider)] || "Other";

/** Labels for the status buttons, which say what pressing them does. */
export const DELIVERY_MOVE_LABEL = Object.freeze({
  [DELIVERY_STATUS.BOOKED]: "Rider booked",
  [DELIVERY_STATUS.PICKED_UP]: "Picked up",
  [DELIVERY_STATUS.DELIVERED]: "Delivered",
  [DELIVERY_STATUS.CLOSED]: "Close",
  [DELIVERY_STATUS.CANCELLED]: "Cancel delivery",
  [DELIVERY_STATUS.FAILED]: "Failed",
});

export const deliveryStatusLabel = (status) => DELIVERY_STATUS_LABEL[statusOf(status)] || clean(status) || "Unknown";

/** Whether the delivery's details can still be changed. The Rust save refuses the terminal ones. */
export const isDeliveryEditable = (delivery) => Boolean(delivery)
  && !TERMINAL_DELIVERY_STATUSES.includes(statusOf(delivery.status));

/* --------------------------------------------------------------------------- the form ---------- */

const DRAFT_TEXT_FIELDS = Object.freeze([
  "customer_name", "customer_phone", "address", "landmark", "area_name", "map_link",
  "rider_name", "rider_phone", "tracking_link", "booking_ref", "notes",
]);

/**
 * A new attempt's form, prefilled from the order and the settings.
 *
 * A second attempt also starts from the first one's area, landmark, map link and quote, because the
 * customer has not moved; the rider fields start empty, because the rider has.
 */
export const newDeliveryDraft = ({ order, settings, previous = null } = {}) => {
  const knownProvider = DELIVERY_PROVIDER_IDS.includes(statusOf(settings?.default_provider));
  const paidBy = statusOf(settings?.default_paid_by) === PAID_BY.CUSTOMER ? PAID_BY.CUSTOMER : PAID_BY.SHOP;
  const area = clean(previous?.area_name);
  let quoted = paiseToInput(previous?.quoted_paise);
  if (!quoted && area) {
    const usual = usualChargeForArea(settings, area);
    if (Number.isFinite(usual)) quoted = paiseToInput(usual);
  }
  return {
    id: "",
    order_id: canonicalInventoryId(order?.id),
    customer_name: clean(order?.customer_name),
    customer_phone: clean(order?.customer_mobile),
    address: clean(order?.delivery_address) || clean(previous?.address),
    landmark: clean(previous?.landmark),
    area_name: area,
    map_link: clean(previous?.map_link),
    provider: knownProvider ? statusOf(settings.default_provider) : (previous ? statusOf(previous.provider) || "rapido" : "rapido"),
    paid_by: previous ? (statusOf(previous.paid_by) === PAID_BY.CUSTOMER ? PAID_BY.CUSTOMER : PAID_BY.SHOP) : paidBy,
    quoted,
    quotedFromArea: false,
    rider_name: "",
    rider_phone: "",
    tracking_link: "",
    booking_ref: "",
    notes: "",
  };
};

/** An existing delivery as the form holds it. */
export const deliveryToDraft = (delivery) => {
  const draft = { id: clean(delivery?.id), order_id: canonicalInventoryId(delivery?.order_id) };
  for (const field of DRAFT_TEXT_FIELDS) draft[field] = clean(delivery?.[field]);
  draft.provider = statusOf(delivery?.provider) || "other";
  draft.paid_by = statusOf(delivery?.paid_by) === PAID_BY.CUSTOMER ? PAID_BY.CUSTOMER : PAID_BY.SHOP;
  draft.quoted = paiseToInput(delivery?.quoted_paise);
  draft.quotedFromArea = false;
  return draft;
};

/**
 * Choosing an area fills in its usual charge, but only into an empty quote (or one the area itself
 * filled): a number somebody typed after phoning the rider is never overwritten.
 */
export const applyDraftArea = (draft, areaName, settings) => {
  const next = { ...draft, area_name: areaName };
  if (clean(draft?.quoted) && !draft?.quotedFromArea) return next;
  const usual = usualChargeForArea(settings, areaName);
  if (Number.isFinite(usual)) return { ...next, quoted: paiseToInput(usual), quotedFromArea: true };
  if (draft?.quotedFromArea) return { ...next, quoted: "", quotedFromArea: false };
  return next;
};

/**
 * The form as the payload `saveLocalDelivery` takes, or the first thing wrong with it.
 *
 * @returns {{ok: true, delivery: object} | {ok: false, message: string}}
 */
export const draftToDeliveryPayload = (draft, { createdBy = "" } = {}) => {
  const orderId = canonicalInventoryId(draft?.order_id);
  if (!orderId) return { ok: false, message: "This delivery is not linked to an order. Reopen the order and try again." };
  if (!clean(draft?.address) && !clean(draft?.map_link)) {
    return { ok: false, message: "Enter the address or a map link, so the rider knows where to go." };
  }
  const provider = statusOf(draft?.provider);
  if (!DELIVERY_PROVIDER_IDS.includes(provider)) return { ok: false, message: "Choose who is carrying it: Rapido, Uber, own staff or other." };
  const paidBy = statusOf(draft?.paid_by);
  if (paidBy !== PAID_BY.SHOP && paidBy !== PAID_BY.CUSTOMER) return { ok: false, message: "Choose who pays for the delivery: the shop or the customer." };
  const quoted = rupeesToPaise(draft?.quoted);
  if (Number.isNaN(quoted)) return { ok: false, message: "The quoted amount must be in rupees, like 60 or 72.50. Leave it blank if you do not know it yet." };
  const delivery = { order_id: orderId, provider, paid_by: paidBy, quoted_paise: quoted };
  for (const field of DRAFT_TEXT_FIELDS) delivery[field] = clean(draft?.[field]);
  if (clean(draft?.id)) delivery.id = clean(draft.id);
  else delivery.created_by = clean(createdBy) || null;
  return { ok: true, delivery };
};

/* ------------------------------------------------------------------------ one button press ---- */

/**
 * The fields the order's own Send records, taken from the delivery: who is carrying it, how to
 * reach them, where to track it.
 */
export const deliveryOrderSendPatch = (delivery) => {
  const patch = { carrier: providerLabel(delivery?.provider) };
  const contact = clean(delivery?.rider_phone);
  const tracking = clean(delivery?.tracking_link);
  const reference = clean(delivery?.booking_ref);
  if (contact) patch.carrier_contact = contact;
  if (tracking) patch.tracking_url = tracking;
  if (reference) patch.carrier_reference = reference;
  return patch;
};

/**
 * What pressing one status button will do, checked before anything is written.
 *
 * `orderTo` is the order move that has to happen with it (`SENT` on pickup of a packed order: that
 * is the Send that creates the bill; `DELIVERED` when the parcel arrives). `patch` is what goes to
 * `setLocalDeliveryStatus`.
 *
 * @returns {{ok: false, message: string} | {ok: true, message: "", patch: object, orderTo: string|null, orderPatch: object}}
 */
export const planDeliveryMove = ({ order, delivery, to, reason = "", finalInput = "", byUser = "" } = {}) => {
  const target = statusOf(to);
  const check = validateDeliveryMove({ delivery, to: target, reason });
  if (!check.ok) return { ok: false, message: check.message };
  const patch = {};
  if (clean(byUser)) patch.by_user = clean(byUser);
  if (REASON_REQUIRED_STATUSES.includes(target)) patch.status_reason = clean(reason);
  if (target === DELIVERY_STATUS.CLOSED) {
    const final = closingFinalPaise(delivery, finalInput);
    if (Number.isNaN(final)) {
      return { ok: false, message: "The final amount must be in rupees, like 60 or 72.50. Leave it blank to use the quoted amount." };
    }
    if (final !== null) patch.final_paise = final;
  }
  const effect = orderEffectOfDeliveryMove({ order, to: target });
  const orderTo = effect?.orderTo || null;
  return {
    ok: true,
    message: "",
    patch,
    orderTo,
    orderPatch: orderTo === ORDER_STATUS.SENT ? deliveryOrderSendPatch(delivery) : {},
  };
};

/* ------------------------------------------------------------------- the charge on the bill ---- */

/** The Other Charges type that means delivery, or `null` when the shop has not set one up. */
export const findDeliveryChargeType = (chargeTypes) => {
  const active = (Array.isArray(chargeTypes) ? chargeTypes : []).filter((type) => type && type.active !== false);
  const named = (type) => clean(type.charge_name || type.name).toLowerCase();
  return active.find((type) => named(type) === "delivery")
    || active.find((type) => named(type) === "delivery charge")
    || active.find((type) => /deliver/.test(named(type)))
    || null;
};

/**
 * The delivery charge to put on the order's bill when it is sent, and what to say on the POS.
 *
 * Only when the customer pays and there is an amount. With no Delivery charge set up, the money is
 * not dropped in silence: the note says so, with the amount, so the cashier can collect it.
 *
 * @returns {{charges: Array<object>, note: string, tone: "info"|"warning"|""}}
 */
export const deliveryBillCharge = ({ delivery, chargeTypes } = {}) => {
  if (statusOf(delivery?.paid_by) !== PAID_BY.CUSTOMER) return { charges: [], note: "", tone: "" };
  const paise = deliveryChargePaise(delivery);
  if (!Number.isFinite(paise)) {
    return {
      charges: [],
      note: "The customer pays for this delivery, but no amount was entered, so no delivery charge is on this bill. Add it under Other Charges if it applies.",
      tone: "warning",
    };
  }
  if (paise === 0) return { charges: [], note: "", tone: "" };
  const rupees = paise / 100;
  const type = findDeliveryChargeType(chargeTypes);
  if (!type) {
    return {
      charges: [],
      note: `The customer pays ${formatRupees(rupees)} for delivery, but no Delivery charge is set up, so it is NOT on this bill. Add a charge named "Delivery" in Settings > Other Charges, or collect it separately.`,
      tone: "warning",
    };
  }
  return {
    charges: [{ charge_type_id: type.id, quantity: 1, measurement: "", manualAmount: rupees.toFixed(2) }],
    note: `Delivery charge ${formatRupees(rupees)} (paid by the customer) is on this bill under Other Charges.`,
    tone: "info",
  };
};

/* ----------------------------------------------------------------------- the Deliveries board -- */

export const DELIVERY_BOARD_GROUPS = Object.freeze([
  Object.freeze({ key: "pending", label: "Pending", hint: "Book a rider" }),
  Object.freeze({ key: "booked", label: "Booked", hint: "Rider coming to the shop" }),
  Object.freeze({ key: "picked_up", label: "Picked up", hint: "On the way to the customer" }),
  Object.freeze({ key: "to_close", label: "Delivered today / to close", hint: "Enter the final charge and close" }),
]);

/** "12m", "1h 05m". Empty when the time could not be read. */
export const minutesLabel = (minutes) => {
  if (!Number.isFinite(minutes) || minutes < 0) return "";
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};

/**
 * The Deliveries board: open attempts by status, plus what still needs closing and what was closed
 * today. Late cards first, then the longest-waiting.
 *
 * An attempt with a status this app does not know is returned in `problems`, never dropped: a
 * delivery that silently is not on the board is the failure the board exists to prevent.
 */
export const buildDeliveryBoard = ({ orders = [], nowMs, overdueMinutes } = {}) => {
  const groups = Object.fromEntries(DELIVERY_BOARD_GROUPS.map((group) => [group.key, []]));
  const problems = [];
  const today = shopDateKey(nowMs);
  for (const order of Array.isArray(orders) ? orders : []) {
    if (!order || clean(order.deleted_at)) continue;
    for (const delivery of deliveriesOf(order)) {
      const status = statusOf(delivery.status);
      const card = {
        key: clean(delivery.id) || `${canonicalInventoryId(order.id)}-${delivery.attempt_no}`,
        order,
        delivery,
        status,
        minutes: minutesInStatus(delivery, nowMs),
        overdue: isDeliveryOverdue(delivery, nowMs, overdueMinutes),
      };
      if (status === DELIVERY_STATUS.PENDING || status === DELIVERY_STATUS.BOOKED || status === DELIVERY_STATUS.PICKED_UP) {
        groups[status].push(card);
      } else if (status === DELIVERY_STATUS.DELIVERED) {
        groups.to_close.push(card);
      } else if (status === DELIVERY_STATUS.CLOSED) {
        if (today && shopDateKey(delivery.closed_at) === today) groups.to_close.push(card);
      } else if (status !== DELIVERY_STATUS.CANCELLED && status !== DELIVERY_STATUS.FAILED) {
        problems.push({
          ...card,
          message: `${clean(order.order_no) || "An order"} has a delivery with an unknown status (${status || "blank"}), so it is not on the board.`,
        });
      }
    }
  }
  const byUrgency = (a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    // Delivered (waiting to close) before closed; then the one waiting longest.
    if (a.status !== b.status) return a.status === DELIVERY_STATUS.DELIVERED ? -1 : b.status === DELIVERY_STATUS.DELIVERED ? 1 : 0;
    return (Number.isFinite(b.minutes) ? b.minutes : -1) - (Number.isFinite(a.minutes) ? a.minutes : -1);
  };
  const columns = DELIVERY_BOARD_GROUPS.map((group) => ({ ...group, cards: [...groups[group.key]].sort(byUrgency) }));
  const open = columns.filter((column) => column.key !== "to_close").reduce((sum, column) => sum + column.cards.length, 0);
  const overdue = columns.reduce((sum, column) => sum + column.cards.filter((card) => card.overdue).length, 0);
  const toClose = groups.to_close.filter((card) => card.status === DELIVERY_STATUS.DELIVERED).length;
  return { columns, openCount: open, overdueCount: overdue, toCloseCount: toClose, problems };
};

/* ------------------------------------------------------------------------ the reports -------- */

/**
 * Sales per shop day, in rupees, from the invoice rows Report Center already holds for its range,
 * or `null` when those rows cannot stand for that range: not loaded, failed, or for other dates.
 * Cost as % of sales then says "unavailable" — dividing by a sales figure that is not there would
 * print a confident, wrong percentage.
 *
 * Cancelled bills are not sales. Summed in paise so the grouping cannot drift by a float epsilon.
 */
export const resolveDeliverySalesByDay = ({
  rows,
  loadError = "",
  serverError = "",
  loadedFrom = "",
  loadedTo = "",
  dateFrom = "",
  dateTo = "",
} = {}) => {
  if (clean(loadError) || clean(serverError)) return null;
  if (!Array.isArray(rows)) return null;
  if (!clean(dateFrom) || !clean(dateTo)) return null;
  if (clean(loadedFrom) !== clean(dateFrom) || clean(loadedTo) !== clean(dateTo)) return null;
  const paiseByDay = new Map();
  for (const row of rows) {
    if (!row || typeof row !== "object") return null;
    if (clean(row.sale_status || row.status).toUpperCase() === "CANCELLED") continue;
    const key = shopDateKey(row.sale_date || row.transaction_date || row.bill_date);
    const amount = Number(row.total_amount ?? row.net_total);
    // A bill with no readable day or amount would make the day's total short without a word.
    if (!key || !Number.isFinite(amount)) return null;
    paiseByDay.set(key, (paiseByDay.get(key) || 0) + Math.round(amount * 100));
  }
  return Object.fromEntries([...paiseByDay.entries()].map(([key, paise]) => [key, paise / 100]));
};

/* ------------------------------------------------------------------------- settings form ----- */

/** The saved settings as the Settings form holds them (rupees as text). */
export const settingsToForm = (settings) => ({
  pickup_address: clean(settings?.pickup_address),
  pickup_pin: clean(settings?.pickup_pin),
  default_provider: DELIVERY_PROVIDER_IDS.includes(statusOf(settings?.default_provider)) ? statusOf(settings.default_provider) : "rapido",
  default_paid_by: statusOf(settings?.default_paid_by) === PAID_BY.CUSTOMER ? PAID_BY.CUSTOMER : PAID_BY.SHOP,
  overdue_minutes: Number.isFinite(Number(settings?.overdue_minutes)) && settings?.overdue_minutes !== null && settings?.overdue_minutes !== ""
    ? String(settings.overdue_minutes)
    : "",
  areas: (Array.isArray(settings?.areas) ? settings.areas : []).map((area) => ({
    id: clean(area?.id),
    name: clean(area?.name),
    usual: paiseToInput(area?.usual_paise),
  })),
  templates: {
    booked: String(settings?.templates?.booked ?? ""),
    picked_up: String(settings?.templates?.picked_up ?? ""),
    delivered: String(settings?.templates?.delivered ?? ""),
  },
});

/**
 * The Settings form back as the settings JSON, or what is wrong with it. Blank area rows are
 * dropped (an unfinished "Add area" is not an area); a named area with a bad charge is refused.
 *
 * @returns {{ok: true, settings: object} | {ok: false, message: string}}
 */
export const formToSettings = (form) => {
  const minutesText = clean(form?.overdue_minutes);
  const minutes = Number(minutesText);
  if (!minutesText || !Number.isInteger(minutes) || minutes < 5 || minutes > 600) {
    return { ok: false, message: "Late after must be a whole number of minutes, between 5 and 600." };
  }
  const areas = [];
  const seen = new Set();
  for (const area of Array.isArray(form?.areas) ? form.areas : []) {
    const name = clean(area?.name);
    if (!name && !clean(area?.usual)) continue;
    if (!name) return { ok: false, message: "An area has a charge but no name. Name it, or remove the row." };
    if (seen.has(name.toLowerCase())) return { ok: false, message: `The area "${name}" is listed twice.` };
    seen.add(name.toLowerCase());
    const usual = rupeesToPaise(area?.usual);
    if (Number.isNaN(usual)) return { ok: false, message: `The usual charge for ${name} must be in rupees, like 60 or 72.50.` };
    areas.push({ id: clean(area?.id), name, usual_paise: usual });
  }
  return {
    ok: true,
    settings: {
      pickup_address: clean(form?.pickup_address),
      pickup_pin: clean(form?.pickup_pin),
      default_provider: DELIVERY_PROVIDER_IDS.includes(statusOf(form?.default_provider)) ? statusOf(form.default_provider) : "rapido",
      default_paid_by: statusOf(form?.default_paid_by) === PAID_BY.CUSTOMER ? PAID_BY.CUSTOMER : PAID_BY.SHOP,
      overdue_minutes: minutes,
      areas,
      templates: {
        booked: String(form?.templates?.booked ?? ""),
        picked_up: String(form?.templates?.picked_up ?? ""),
        delivered: String(form?.templates?.delivered ?? ""),
      },
    },
  };
};

/** What the screen says about where the delivery settings came from. */
export const describeDeliverySettingsSource = ({ source = "", dirty = false, error = "" } = {}) => {
  if (dirty) return "Saved on this computer; will reach the other computers when online.";
  if (source === "default") {
    return error
      ? `Delivery settings could not be loaded (${error}). Showing the starting values; nothing is saved yet.`
      : "No delivery settings saved yet. These are the starting values.";
  }
  if (source === "copied") return "Templates copied from another shop. Fill in this shop's pickup address and areas, then Save.";
  if (error) return `Showing the copy on this computer. The latest could not be fetched: ${error}`;
  return "";
};
