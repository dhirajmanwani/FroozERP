/**
 * What the deliveries add up to: the four questions the owner asks about them.
 *
 *   1. daily       — how many went out each day, how many arrived, failed or were cancelled, what
 *                    they cost and how long the rides took
 *   2. cost share  — delivery cost as a percentage of the day's (and month's) sales
 *   3. by area     — where deliveries go, what each area usually costs and how often it fails
 *   4. by provider — Rapido against Uber against own staff, on the same measures
 *
 * The output has exactly the shape of `buildOrderReports` in `orderReporting.js` — a top-level
 * `{ ok, error, range, problems, excluded }` and one `{ report, ok, error, range, rows, summary,
 * problems }` per key of {@link DELIVERY_REPORT} — so Report Center renders delivery reports with
 * the same code path as order reports. The day key ({@link shopDateKey}) and the range vocabulary
 * ({@link resolveOrderReportRange}) are borrowed from that module rather than re-derived, so an
 * order report and a delivery report for "today" mean the same day.
 *
 * ## One filtered source, four reports
 *
 * As in `orderReporting.js`, every builder reduces over the same `source.deliveries`, built once by
 * {@link buildDeliveryReportSource}, and every summary is reduced from its own rows. Totals that come
 * from one collection next to a table from another are the disagreement `CLAUDE.md` warns about.
 *
 * ## Which day a delivery belongs to
 *
 * The shop day its attempt was **started** (`created_at`). Not the day it was closed: a report for
 * yesterday must not change because somebody closed yesterday's ride this morning.
 *
 * ## What counts as cost
 *
 * - delivered or closed: the charge ({@link deliveryChargePaise}: final, else quoted). A completed
 *   delivery with no charge recorded at all is counted in `uncosted` and named in `problems`, so the
 *   cost total is never quietly short.
 * - failed: only an explicitly recorded `final_paise`. Whether a failed ride was paid for depends on
 *   whether the rider ever came, and only a person who typed a final charge knows that.
 * - cancelled and still-open attempts: nothing.
 *
 * Cost is split by who paid it. `shopCost` is what the shop spent; `customerCost` is what customers
 * paid (recovered on their bill). A delivery with no `paid_by` is counted as shop-paid, the default.
 *
 * ## Money and errors
 *
 * Integer paise inside, rupees (2 dp) out, like the order reports. A report that could not be built
 * has `summary: null`. Cost as a percentage of sales is `null` — never 0 — when sales are not known
 * (`salesByDay` null), unreadable, or zero: there is no honest percentage of nothing.
 *
 * Pure: no clock read inside, no React, no I/O; `nowMs` is passed in.
 */

import {
  DELIVERY_STATUS,
  KNOWN_DELIVERY_STATUSES,
  OPEN_DELIVERY_STATUSES,
  PAID_BY,
  deliveriesOf,
  deliveryChargePaise,
  storedPaise,
} from "./deliveryLifecycle.js";
import { isKnownProvider, providerFor } from "./deliveryProviders.js";
import { isDateKeyInRange, resolveOrderReportRange, shopDateKey } from "./orderReporting.js";
import { formatIndianReportDate } from "./reportRefresh.js";
import { canonicalInventoryId } from "./stockInventory.js";

export const DELIVERY_REPORT = Object.freeze({
  DAILY: "deliveryDaily",
  COST_SHARE: "deliveryCostShare",
  BY_AREA: "deliveryByArea",
  BY_PROVIDER: "deliveryByProvider",
});

export const DELIVERY_REPORT_ERROR = Object.freeze({
  /** The order list (which carries the deliveries) could not be read. */
  ORDERS_UNREADABLE: "ORDERS_UNREADABLE",
  RANGE_UNREADABLE: "RANGE_UNREADABLE",
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
});

export const DELIVERY_REPORT_PROBLEM = Object.freeze({
  ORDER_UNREADABLE: "ORDER_UNREADABLE",
  DELIVERY_UNREADABLE: "DELIVERY_UNREADABLE",
  DELIVERY_DUPLICATE: "DELIVERY_DUPLICATE",
  DELIVERY_DATE_UNREADABLE: "DELIVERY_DATE_UNREADABLE",
  DELIVERY_STATUS_UNKNOWN: "DELIVERY_STATUS_UNKNOWN",
  DELIVERY_PROVIDER_UNKNOWN: "DELIVERY_PROVIDER_UNKNOWN",
  DELIVERY_CHARGE_MISSING: "DELIVERY_CHARGE_MISSING",
  SALES_UNREADABLE: "SALES_UNREADABLE",
});

/** How the attempt ended, for the counters. Every attempt is exactly one of these. */
export const DELIVERY_OUTCOME = Object.freeze({
  DELIVERED: "delivered",
  FAILED: "failed",
  CANCELLED: "cancelled",
  OPEN: "open",
  UNKNOWN: "unknown",
});

/** Beyond this many days a range lists only the days that had deliveries or sales. */
export const MAX_FILLED_DAYS = 366;

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = Object.freeze(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]);

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());
const statusOf = (value) => text(value).toLowerCase();
const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

const asTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

const paiseToRupees = (paise) => Math.round(paise) / 100;
const rupeesToPaiseExact = (rupees) => Math.round(Number(`${rupees}e2`));

/** `part / whole` as a percentage with two decimals, or null when there is no honest answer. */
const percent = (partPaise, wholePaise) => (
  Number.isFinite(partPaise) && Number.isFinite(wholePaise) && wholePaise > 0
    ? Math.round((partPaise * 10000) / wholePaise) / 100
    : null
);

/** Average of a total of tenths-of-minutes over a count, to one decimal, or null when none. */
const averageTenths = (tenths, count) => (count > 0 ? Math.round(tenths / count) / 10 : null);

/* --------------------------------------------------------------------- flatten and time ------ */

/** The raw list, whatever wrapper it arrived in, or null when it is not a list at all. */
const readOrderRows = (input) => {
  if (Array.isArray(input)) return input;
  if (isPlainObject(input) && Array.isArray(input.orders)) return input.orders;
  return null;
};

const collectDeliveries = (rows) => {
  const deliveries = [];
  const problems = [];
  const excluded = { deletedOrders: 0, unreadableOrders: 0, unreadableDeliveries: 0 };
  rows.forEach((order, index) => {
    if (!isPlainObject(order)) {
      excluded.unreadableOrders += 1;
      problems.push({
        code: DELIVERY_REPORT_PROBLEM.ORDER_UNREADABLE,
        orderId: null,
        orderNo: "",
        deliveryId: null,
        message: `Row ${index + 1} of the order list is not an order, so any deliveries on it are missing from these totals.`,
      });
      return;
    }
    // A deleted order's deliveries go with it, quietly: a deletion is a decision, not a fault.
    if (text(order.deleted_at)) {
      excluded.deletedOrders += 1;
      return;
    }
    const orderNo = text(order.order_no);
    if (order.deliveries !== undefined && order.deliveries !== null && !Array.isArray(order.deliveries)) {
      excluded.unreadableDeliveries += 1;
      problems.push({
        code: DELIVERY_REPORT_PROBLEM.DELIVERY_UNREADABLE,
        orderId: canonicalInventoryId(order.id) || null,
        orderNo,
        deliveryId: null,
        message: `The deliveries of order ${orderNo || canonicalInventoryId(order.id) || `#${index + 1}`} could not be read and are missing from these totals.`,
      });
      return;
    }
    const raw = Array.isArray(order.deliveries) ? order.deliveries : [];
    const unreadable = raw.filter((entry) => !isPlainObject(entry)).length;
    if (unreadable > 0) {
      excluded.unreadableDeliveries += unreadable;
      problems.push({
        code: DELIVERY_REPORT_PROBLEM.DELIVERY_UNREADABLE,
        orderId: canonicalInventoryId(order.id) || null,
        orderNo,
        deliveryId: null,
        message: `${unreadable} delivery record(s) on order ${orderNo || canonicalInventoryId(order.id)} could not be read and are missing from these totals.`,
      });
    }
    for (const delivery of deliveriesOf(order)) {
      deliveries.push({
        ...delivery,
        // Kept as text, never coerced: ids are opaque strings.
        order_id: text(delivery.order_id) || text(order.id),
        order_no: orderNo,
        order_status: text(order.status),
        branch_id: order.branch_id ?? null,
      });
    }
  });
  return { deliveries, problems, excluded };
};

/**
 * Every delivery of every (not deleted) order, each tagged with its order's `order_no`,
 * `order_status` and `branch_id` — the same extra fields `listLocalDeliveries()` carries.
 * Returns `[]` for anything that is not an order list.
 */
export const flattenDeliveries = (orders) => {
  const rows = readOrderRows(orders);
  return rows === null ? [] : collectDeliveries(rows).deliveries;
};

const latestEventTime = (delivery, status, notAfter = null) => {
  let best = null;
  for (const event of Array.isArray(delivery?.events) ? delivery.events : []) {
    if (!isPlainObject(event) || statusOf(event.to_status) !== status) continue;
    const at = asTime(event.at);
    if (at === null || (notAfter !== null && at > notAfter)) continue;
    if (best === null || at > best) best = at;
  }
  return best;
};

/**
 * Minutes from pickup to delivery, to one decimal, or `null`.
 *
 * Read from the events (the last `delivered` event and the last `picked_up` event before it); when
 * the events do not carry both — a pulled order whose event list was capped, say — the delivery's
 * own `picked_up_at` and `delivered_at` stamps, which are written by the same transaction. A
 * negative or unreadable span is `null`, never 0: a ride that took no time did not happen.
 */
export const deliveryMinutes = (delivery) => {
  if (!isPlainObject(delivery)) return null;
  let deliveredAt = latestEventTime(delivery, DELIVERY_STATUS.DELIVERED);
  let pickedUpAt = deliveredAt === null ? null : latestEventTime(delivery, DELIVERY_STATUS.PICKED_UP, deliveredAt);
  if (deliveredAt === null || pickedUpAt === null) {
    deliveredAt = asTime(delivery.delivered_at);
    pickedUpAt = asTime(delivery.picked_up_at);
  }
  if (deliveredAt === null || pickedUpAt === null || deliveredAt < pickedUpAt) return null;
  return Math.round((deliveredAt - pickedUpAt) / 6000) / 10;
};

const outcomeOf = (status) => {
  if (status === DELIVERY_STATUS.DELIVERED || status === DELIVERY_STATUS.CLOSED) return DELIVERY_OUTCOME.DELIVERED;
  if (status === DELIVERY_STATUS.FAILED) return DELIVERY_OUTCOME.FAILED;
  if (status === DELIVERY_STATUS.CANCELLED) return DELIVERY_OUTCOME.CANCELLED;
  if (OPEN_DELIVERY_STATUSES.includes(status)) return DELIVERY_OUTCOME.OPEN;
  return DELIVERY_OUTCOME.UNKNOWN;
};

/** The day an attempt was started: `created_at`, else its earliest readable event. */
const startedOn = (delivery) => {
  const fromCreated = shopDateKey(delivery.created_at);
  if (fromCreated) return fromCreated;
  let earliest = null;
  for (const event of Array.isArray(delivery.events) ? delivery.events : []) {
    const at = asTime(event?.at);
    if (at !== null && (earliest === null || at < earliest)) earliest = at;
  }
  return earliest === null ? "" : shopDateKey(earliest);
};

/* ----------------------------------------------------------------------------- sales -------- */

/**
 * `salesByDay` read once: `{ available, byDay: Map<day, paise|null> }`. A day whose value is not a
 * number maps to `null` (unknown) and is named in problems; a day missing from a supplied map had no
 * sales recorded, which is a real zero.
 */
const readSales = (salesByDay, problems) => {
  if (salesByDay === null || salesByDay === undefined) return { available: false, byDay: new Map() };
  if (!isPlainObject(salesByDay)) {
    problems.push({
      code: DELIVERY_REPORT_PROBLEM.SALES_UNREADABLE,
      orderId: null,
      orderNo: "",
      deliveryId: null,
      message: "The sales figures could not be read, so delivery cost cannot be shown as a share of sales.",
    });
    return { available: false, byDay: new Map() };
  }
  const byDay = new Map();
  for (const [rawKey, value] of Object.entries(salesByDay)) {
    const day = shopDateKey(rawKey);
    if (!day) continue;
    const rupees = value === null || value === "" || typeof value === "boolean" ? Number.NaN : Number(value);
    if (!Number.isFinite(rupees)) {
      byDay.set(day, null);
      problems.push({
        code: DELIVERY_REPORT_PROBLEM.SALES_UNREADABLE,
        orderId: null,
        orderNo: "",
        deliveryId: null,
        message: `The sales for ${formatIndianReportDate(day)} could not be read, so that day's cost share is not shown.`,
      });
      continue;
    }
    byDay.set(day, rupeesToPaiseExact(rupees));
  }
  return { available: true, byDay };
};

/* ---------------------------------------------------------------------------- source -------- */

const emptySource = (error, range, nowMs) => ({
  ok: false,
  error,
  range,
  nowMs,
  deliveries: [],
  days: [],
  sales: { available: false, byDay: new Map() },
  problems: [],
  excluded: { deletedOrders: 0, unreadableOrders: 0, unreadableDeliveries: 0, outOfRange: 0 },
});

/** Every day of a resolved range, `YYYY-MM-DD`, or null when the range is too long to fill. */
const daysOfRange = ({ date_from, date_to }) => {
  const [fy, fm, fd] = date_from.split("-").map(Number);
  const [ty, tm, td] = date_to.split("-").map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  if ((end - start) / DAY_MS + 1 > MAX_FILLED_DAYS) return null;
  const days = [];
  for (let at = start; at <= end; at += DAY_MS) days.push(new Date(at).toISOString().slice(0, 10));
  return days;
};

/**
 * The one filtered collection all four delivery reports are built from.
 *
 * @param {{orders: Array|{orders: Array}|null, salesByDay?: Object<string, number>|null}} input
 * @param {{range?: string, date_from?: string, date_to?: string}} params the range control's state
 * @param {number} nowMs
 */
export const buildDeliveryReportSource = ({ orders, salesByDay = null } = {}, params = {}, nowMs = Date.now()) => {
  let range;
  try {
    range = resolveOrderReportRange(params, nowMs);
  } catch (error) {
    return emptySource({ code: DELIVERY_REPORT_ERROR.RANGE_UNREADABLE, message: String(error?.message || error) }, null, nowMs);
  }
  const rows = readOrderRows(orders);
  if (rows === null) {
    return emptySource({
      code: DELIVERY_REPORT_ERROR.ORDERS_UNREADABLE,
      message: "The orders on this device could not be read, so these delivery reports are not showing nothing — they are showing nothing known. Reopen the screen, and restart the app if it stays this way.",
    }, range, nowMs);
  }

  const collected = collectDeliveries(rows);
  const problems = [...collected.problems];
  const excluded = { ...collected.excluded, outOfRange: 0 };
  const seen = new Set();
  const deliveries = [];

  for (const raw of collected.deliveries) {
    const id = canonicalInventoryId(raw.id);
    const orderNo = raw.order_no;
    const attempt = Number(raw.attempt_no);
    const label = `${orderNo || canonicalInventoryId(raw.order_id) || "an order"}${Number.isInteger(attempt) && attempt > 0 ? ` (attempt ${attempt})` : ""}`;
    const reference = { orderId: canonicalInventoryId(raw.order_id) || null, orderNo, deliveryId: id || null };
    if (id) {
      if (seen.has(id)) {
        problems.push({ code: DELIVERY_REPORT_PROBLEM.DELIVERY_DUPLICATE, ...reference, message: `The delivery for ${label} appears twice; it is counted once.` });
        continue;
      }
      seen.add(id);
    }
    const day = startedOn(raw);
    if (!day) {
      excluded.unreadableDeliveries += 1;
      problems.push({ code: DELIVERY_REPORT_PROBLEM.DELIVERY_DATE_UNREADABLE, ...reference, message: `The delivery for ${label} has no readable date, so it is missing from these totals.` });
      continue;
    }
    if (!isDateKeyInRange(day, range)) {
      excluded.outOfRange += 1;
      continue;
    }

    const status = statusOf(raw.status);
    const statusKnown = KNOWN_DELIVERY_STATUSES.includes(status);
    if (!statusKnown) {
      problems.push({ code: DELIVERY_REPORT_PROBLEM.DELIVERY_STATUS_UNKNOWN, ...reference, message: `The delivery for ${label} has an unrecognised status (${status || "blank"}). It is counted, but what happened to it is unknown.` });
    }
    const providerKnown = isKnownProvider(raw.provider);
    const providerId = providerKnown ? providerFor(raw.provider).id : (statusOf(raw.provider) || "");
    if (!providerKnown && providerId) {
      problems.push({ code: DELIVERY_REPORT_PROBLEM.DELIVERY_PROVIDER_UNKNOWN, ...reference, message: `The delivery for ${label} names a provider this app does not know (${providerId}).` });
    }

    const outcome = outcomeOf(status);
    let costPaise = null;
    let uncosted = false;
    if (outcome === DELIVERY_OUTCOME.DELIVERED) {
      costPaise = deliveryChargePaise(raw);
      if (costPaise === null) {
        uncosted = true;
        problems.push({ code: DELIVERY_REPORT_PROBLEM.DELIVERY_CHARGE_MISSING, ...reference, message: `The delivery for ${label} was delivered but has no charge recorded, so the cost totals are short by it.` });
      }
    } else if (outcome === DELIVERY_OUTCOME.FAILED) {
      costPaise = storedPaise(raw.final_paise);
    }

    const areaName = text(raw.area_name).replace(/\s+/g, " ");
    deliveries.push({
      raw,
      id,
      orderId: reference.orderId,
      orderNo,
      label,
      day,
      status,
      statusKnown,
      outcome,
      providerId,
      providerKnown,
      providerLabel: providerKnown ? providerFor(providerId).label : (providerId || "Not set"),
      areaKey: areaName.toLowerCase(),
      areaName: areaName || "No area",
      customerPays: statusOf(raw.paid_by) === PAID_BY.CUSTOMER,
      costPaise,
      uncosted,
      minutes: outcome === DELIVERY_OUTCOME.DELIVERED ? deliveryMinutes(raw) : null,
    });
  }

  const sales = readSales(salesByDay, problems);
  const filled = daysOfRange(range);
  const daySet = new Set(filled || []);
  for (const delivery of deliveries) daySet.add(delivery.day);
  for (const day of sales.byDay.keys()) if (isDateKeyInRange(day, range)) daySet.add(day);
  const days = [...daySet].sort();

  return { ok: true, error: null, range, nowMs, deliveries, days, sales, problems, excluded };
};

const failure = (report, code, message, range = null) => ({
  report,
  ok: false,
  error: { code, message },
  range,
  rows: [],
  summary: null,
  problems: [],
});

const sourceFailure = (report, source) => {
  if (!isPlainObject(source) || !Array.isArray(source.deliveries) || !Array.isArray(source.days)) {
    return failure(report, DELIVERY_REPORT_ERROR.SOURCE_UNREADABLE, "This report was not given a delivery source to build from, so it has no figures to show.");
  }
  if (!source.ok) {
    return failure(report, source.error?.code || DELIVERY_REPORT_ERROR.ORDERS_UNREADABLE, source.error?.message || "The deliveries could not be read.", source.range || null);
  }
  return null;
};

/** Counts every summary carries, so a short total always says why it is short. */
const provenance = (source) => ({
  unreadableDeliveries: source.excluded.unreadableDeliveries + source.excluded.unreadableOrders,
  deletedOrders: source.excluded.deletedOrders,
  unknownStatus: source.deliveries.filter((delivery) => !delivery.statusKnown).length,
  uncosted: source.deliveries.filter((delivery) => delivery.uncosted).length,
  problems: source.problems.length,
});

/** A blank set of counters. The outcome counters always add up to `deliveries`. */
const counters = () => ({
  deliveries: 0,
  delivered: 0,
  closed: 0,
  failed: 0,
  cancelled: 0,
  open: 0,
  unknownStatus: 0,
  costPaise: 0,
  shopCostPaise: 0,
  customerCostPaise: 0,
  costed: 0,
  uncosted: 0,
  timed: 0,
  minutesTenths: 0,
});

const tally = (row, delivery) => {
  row.deliveries += 1;
  if (delivery.outcome === DELIVERY_OUTCOME.DELIVERED) row.delivered += 1;
  else if (delivery.outcome === DELIVERY_OUTCOME.FAILED) row.failed += 1;
  else if (delivery.outcome === DELIVERY_OUTCOME.CANCELLED) row.cancelled += 1;
  else if (delivery.outcome === DELIVERY_OUTCOME.OPEN) row.open += 1;
  else row.unknownStatus += 1;
  if (delivery.status === DELIVERY_STATUS.CLOSED) row.closed += 1;
  if (delivery.costPaise !== null) {
    row.costed += 1;
    row.costPaise += delivery.costPaise;
    if (delivery.customerPays) row.customerCostPaise += delivery.costPaise;
    else row.shopCostPaise += delivery.costPaise;
  }
  if (delivery.uncosted) row.uncosted += 1;
  if (delivery.minutes !== null) {
    row.timed += 1;
    row.minutesTenths += Math.round(delivery.minutes * 10);
  }
  return row;
};

/** Paise and tenths turned into the rupees and minutes a row shows. */
const present = ({ costPaise, shopCostPaise, customerCostPaise, minutesTenths, ...row }) => ({
  ...row,
  cost: paiseToRupees(costPaise),
  shopCost: paiseToRupees(shopCostPaise),
  customerCost: paiseToRupees(customerCostPaise),
  // Over the deliveries that have a cost, not over every attempt: a cancelled booking is not a
  // cheap delivery.
  averageCost: row.costed > 0 ? paiseToRupees(Math.round(costPaise / row.costed)) : null,
  totalMinutes: minutesTenths / 10,
  averageMinutes: averageTenths(minutesTenths, row.timed),
});

/** Totals reduced from presented rows, never from a second pass over the deliveries. */
const totalsOf = (rows) => {
  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);
  const sumPaise = (key) => rows.reduce((total, row) => total + Math.round(row[key] * 100), 0);
  const costPaise = sumPaise("cost");
  const costed = sum("costed");
  const timed = sum("timed");
  const tenths = rows.reduce((total, row) => total + Math.round(row.totalMinutes * 10), 0);
  return {
    deliveries: sum("deliveries"),
    delivered: sum("delivered"),
    closed: sum("closed"),
    failed: sum("failed"),
    cancelled: sum("cancelled"),
    open: sum("open"),
    cost: paiseToRupees(costPaise),
    shopCost: paiseToRupees(sumPaise("shopCost")),
    customerCost: paiseToRupees(sumPaise("customerCost")),
    costed,
    averageCost: costed > 0 ? paiseToRupees(Math.round(costPaise / costed)) : null,
    timed,
    averageMinutes: averageTenths(tenths, timed),
  };
};

/* --------------------------------------------------------------------------- 1. daily -------- */

/**
 * Each day of the range, including days with no deliveries (a real zero: the deliveries were read
 * and there were none). Counters per row add up to `deliveries`; `delivered` includes closed.
 */
export const buildDeliveryDailyReport = (source) => {
  const refuse = sourceFailure(DELIVERY_REPORT.DAILY, source);
  if (refuse) return refuse;
  const byDay = new Map(source.days.map((day) => [day, counters()]));
  for (const delivery of source.deliveries) tally(byDay.get(delivery.day), delivery);
  const rows = source.days.map((day) => ({ date: day, dateLabel: formatIndianReportDate(day), ...present(byDay.get(day)) }));
  return {
    report: DELIVERY_REPORT.DAILY,
    ok: true,
    error: null,
    range: source.range,
    rows,
    summary: { days: rows.length, ...totalsOf(rows), ...provenance(source) },
    problems: source.problems,
  };
};

/* ---------------------------------------------------------------------- 2. cost share -------- */

const monthLabel = (month) => {
  const [year, index] = month.split("-").map(Number);
  return `${MONTH_NAMES[index - 1] || month} ${year}`;
};

const shareOf = (costPaise, shopCostPaise, salesPaise) => ({
  costPercent: percent(costPaise, salesPaise),
  shopCostPercent: percent(shopCostPaise, salesPaise),
});

/**
 * Delivery cost as a share of sales, per day, with the month totals in `summary.months`.
 *
 * `sales` is null when the sales are not known for that day; the percentages are null when sales
 * are unknown or zero. The summary's `sales` is null if *any* day in the range is unknown, because a
 * total missing a day is not the range's total.
 */
export const buildDeliveryCostShareReport = (source) => {
  const refuse = sourceFailure(DELIVERY_REPORT.COST_SHARE, source);
  if (refuse) return refuse;
  const byDay = new Map(source.days.map((day) => [day, counters()]));
  for (const delivery of source.deliveries) tally(byDay.get(delivery.day), delivery);

  const salesFor = (day) => {
    if (!source.sales.available) return null;
    return source.sales.byDay.has(day) ? source.sales.byDay.get(day) : 0;
  };

  const rows = source.days.map((day) => {
    const row = byDay.get(day);
    const salesPaise = salesFor(day);
    return {
      date: day,
      dateLabel: formatIndianReportDate(day),
      month: day.slice(0, 7),
      deliveries: row.deliveries,
      delivered: row.delivered,
      salesAvailable: salesPaise !== null,
      sales: salesPaise === null ? null : paiseToRupees(salesPaise),
      cost: paiseToRupees(row.costPaise),
      shopCost: paiseToRupees(row.shopCostPaise),
      customerCost: paiseToRupees(row.customerCostPaise),
      uncosted: row.uncosted,
      ...shareOf(row.costPaise, row.shopCostPaise, salesPaise),
    };
  });

  const group = (list) => {
    const known = list.every((row) => row.salesAvailable);
    const costPaise = list.reduce((total, row) => total + Math.round(row.cost * 100), 0);
    const shopCostPaise = list.reduce((total, row) => total + Math.round(row.shopCost * 100), 0);
    const customerCostPaise = list.reduce((total, row) => total + Math.round(row.customerCost * 100), 0);
    const salesPaise = known && list.length > 0 ? list.reduce((total, row) => total + Math.round(row.sales * 100), 0) : null;
    return {
      deliveries: list.reduce((total, row) => total + row.deliveries, 0),
      salesAvailable: salesPaise !== null,
      sales: salesPaise === null ? null : paiseToRupees(salesPaise),
      cost: paiseToRupees(costPaise),
      shopCost: paiseToRupees(shopCostPaise),
      customerCost: paiseToRupees(customerCostPaise),
      ...shareOf(costPaise, shopCostPaise, salesPaise),
    };
  };

  const months = [...new Set(rows.map((row) => row.month))].sort().map((month) => ({
    month,
    monthLabel: monthLabel(month),
    ...group(rows.filter((row) => row.month === month)),
  }));

  return {
    report: DELIVERY_REPORT.COST_SHARE,
    ok: true,
    error: null,
    range: source.range,
    rows,
    summary: {
      days: rows.length,
      ...group(rows),
      // Why a percentage is missing, so the screen can say it rather than draw a blank.
      salesNotice: source.sales.available ? "" : "Sales for this period are not available, so delivery cost cannot be shown as a share of sales.",
      months,
      ...provenance(source),
    },
    problems: source.problems,
  };
};

/* ------------------------------------------------------------------ 3 and 4. grouped -------- */

const groupedReport = (report, source, keyOf, describe) => {
  const refuse = sourceFailure(report, source);
  if (refuse) return refuse;
  const groups = new Map();
  for (const delivery of source.deliveries) {
    const key = keyOf(delivery);
    if (!groups.has(key)) groups.set(key, { key, delivery, row: counters() });
    tally(groups.get(key).row, delivery);
  }
  const rows = [...groups.values()]
    .map(({ key, delivery, row }) => ({ ...describe(key, delivery), ...present(row) }))
    .sort((left, right) => right.deliveries - left.deliveries || String(left.label).localeCompare(String(right.label)));
  return { rows, summary: { ...totalsOf(rows), ...provenance(source) } };
};

/**
 * Where deliveries go. Areas are matched ignoring case and spacing ("Sector 5" and "sector  5" are
 * one area); deliveries with no area are one row, "No area", rather than dropped.
 */
export const buildDeliveryByAreaReport = (source) => {
  const built = groupedReport(DELIVERY_REPORT.BY_AREA, source, (delivery) => delivery.areaKey, (key, delivery) => ({
    areaKey: key,
    areaName: delivery.areaName,
    label: delivery.areaName,
  }));
  if (built.ok === false) return built;
  return {
    report: DELIVERY_REPORT.BY_AREA,
    ok: true,
    error: null,
    range: source.range,
    rows: built.rows,
    summary: { areas: built.rows.length, ...built.summary },
    problems: source.problems,
  };
};

/** Rapido against Uber against own staff. An unknown or blank provider gets its own row. */
export const buildDeliveryByProviderReport = (source) => {
  const built = groupedReport(DELIVERY_REPORT.BY_PROVIDER, source, (delivery) => delivery.providerId, (key, delivery) => ({
    provider: key,
    providerLabel: delivery.providerLabel,
    known: delivery.providerKnown,
    label: delivery.providerLabel,
  }));
  if (built.ok === false) return built;
  return {
    report: DELIVERY_REPORT.BY_PROVIDER,
    ok: true,
    error: null,
    range: source.range,
    rows: built.rows,
    summary: { providers: built.rows.length, ...built.summary },
    problems: source.problems,
  };
};

/* -------------------------------------------------------------------------- all four -------- */

/**
 * All four delivery reports from one source, built once — the same shape as `buildOrderReports`.
 *
 * @param {{orders: Array|{orders: Array}|null, salesByDay: Object<string, number>|null}} input
 *   `orders` as `listLocalCustomerOrders()` hands them over (each carrying `deliveries`);
 *   `salesByDay` `{ "YYYY-MM-DD": rupees }`, or null when sales are not available.
 */
export const buildDeliveryReports = (input = {}, params = {}, nowMs = Date.now()) => {
  const source = buildDeliveryReportSource(isPlainObject(input) ? input : { orders: null }, params, nowMs);
  return {
    ok: source.ok,
    error: source.error,
    range: source.range,
    problems: source.problems,
    excluded: source.excluded,
    [DELIVERY_REPORT.DAILY]: buildDeliveryDailyReport(source),
    [DELIVERY_REPORT.COST_SHARE]: buildDeliveryCostShareReport(source),
    [DELIVERY_REPORT.BY_AREA]: buildDeliveryByAreaReport(source),
    [DELIVERY_REPORT.BY_PROVIDER]: buildDeliveryByProviderReport(source),
  };
};

/** One sentence for the screen, or `""`. Same contract as `describeOrderReportError`. */
export const describeDeliveryReportError = (report) => {
  if (report?.error?.message) return report.error.message;
  const problems = Array.isArray(report?.problems) ? report.problems : [];
  if (problems.length === 0) return "";
  if (problems.length === 1) return problems[0].message;
  return `${problems.length} deliveries or figures could not be fully read, so these figures are incomplete: ${problems[0].message}`;
};
