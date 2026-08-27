/**
 * What the orders add up to: the four questions the owner actually asks about them.
 *
 * Orders live in this device's SQLite and, until this module, were invisible to every report — the
 * board could show what was open right now, and nothing could answer "what did we take last week"
 * or "what do I need to buy at the mandi tomorrow". These are those answers:
 *
 *   1. by date      — what came in each day, what it was worth, what happened to it
 *   2. by product   — how much of each thing was ordered. The mandi list.
 *   3. by customer  — who orders, how often, how much
 *   4. fulfilment   — the individual orders behind the three summaries above
 *
 * `orderLifecycle.js` owns the rules, `ordersBoard.js` owns the live screen; this owns the
 * arithmetic. It is pure: no clock read inside, no React, no I/O. `nowMs` is passed in for the same
 * reason it is in `orderNotifications.js` — ages are reported here, and a clock hidden inside a
 * module that reports ages is untestable.
 *
 * ## One filtered source, four reports
 *
 * Every builder here reduces over the *same* array, `source.orders`, produced once by
 * {@link buildOrderReportSource}. This is not tidiness. `CLAUDE.md` records that a panel whose
 * totals came from one collection and whose table came from another eventually disagreed, and the
 * disagreement read as data loss. Four reports built from four separately-filtered lists would be
 * that bug four times over — and this time across reports as well as within them, so the by-product
 * total and the by-date total could differ and neither would be obviously wrong.
 *
 * ## Money, and why this does not simply call `orderValue`
 *
 * `ordersBoard.orderValue` sums `quantity * agreed_rate` unrounded, which is right for what it does:
 * one order, one card, rounded once when it is drawn. Reports aggregate the same rupees three
 * different ways at once. If rounding happened at the end of each aggregation, the by-product total
 * and the by-date total would be sums of the same money grouped differently and would differ in the
 * last paisa — which, in a report about missing revenue, is indistinguishable from a real
 * discrepancy.
 *
 * So money is rounded exactly once, per line, before any grouping, and every total here is a sum of
 * those same rounded line values. It is accumulated in integer paise (and quantity in integer
 * thousandths) so that grouping order cannot change a total by a float epsilon either. That is
 * `CLAUDE.md`'s "round once per line, then sum" implemented literally.
 * {@link orderReportValue} is the single reporting money function; nothing here computes money
 * anywhere else.
 *
 * ## Dates
 *
 * The shop is in Asia/Kolkata and the day boundary that matters is the shop's, not the reader's.
 * An order taken at 11:30pm on the 21st was taken on the 21st whether it is read in Kolkata, in
 * London or in a test runner someone forgot to set `TZ` on. Every date key here comes from
 * {@link shopDateKey}, which names the zone explicitly rather than inheriting the host's.
 *
 * ## Errors are never zeros
 *
 * `listLocalCustomerOrders()` returns `null` when there is no desktop runtime, and "no orders" and
 * "we could not read the orders" are different sentences that must never render as the same `0`.
 * A report that could not be built carries `error` and a `summary` of **null** — there is no number
 * to show, so none is offered. Rows that could not be read individually do not fail the whole
 * report; they land in `problems` and are counted in `summary.unreadableOrders`, so a total is
 * never quietly short.
 */

import { ORDER_STATUS } from "./orderLifecycle.js";
import { presentOrder } from "./ordersBoard.js";
import { formatIndianReportDate, normalizeReportDate } from "./reportRefresh.js";
import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

/** The shop's clock. Named, never inherited from the host — see the module note on dates. */
export const SHOP_TIME_ZONE = "Asia/Kolkata";

export const ORDER_REPORT = Object.freeze({
  BY_DATE: "ordersByDate",
  BY_PRODUCT: "ordersByProduct",
  BY_CUSTOMER: "ordersByCustomer",
  FULFILMENT: "orderFulfilment",
});

/**
 * Named failures. Stored in `report.error.code` so a screen can branch on the kind of failure
 * rather than on the wording of a sentence.
 */
export const ORDER_REPORT_ERROR = Object.freeze({
  /** The order list itself could not be read — `null`, a string, anything that is not a list. */
  ORDERS_UNREADABLE: "ORDERS_UNREADABLE",
  /** The requested date range does not describe a range. */
  RANGE_UNREADABLE: "RANGE_UNREADABLE",
  /** A builder was handed something that is not a source from {@link buildOrderReportSource}. */
  SOURCE_UNREADABLE: "SOURCE_UNREADABLE",
});

/** Named problems with individual rows. The report still builds; these keep the gap visible. */
export const ORDER_REPORT_PROBLEM = Object.freeze({
  ORDER_UNREADABLE: "ORDER_UNREADABLE",
  ORDER_DATE_UNREADABLE: "ORDER_DATE_UNREADABLE",
  ORDER_STATUS_UNKNOWN: "ORDER_STATUS_UNKNOWN",
  LINE_QUANTITY_UNREADABLE: "LINE_QUANTITY_UNREADABLE",
  LINE_RATE_MISSING: "LINE_RATE_MISSING",
});

/**
 * Statuses in which an order is still in flight.
 *
 * SENT counts as open here even though it is billed: from the owner's side the parcel is out and
 * nobody has confirmed it arrived, which is a thing still owed rather than a thing finished.
 */
const OPEN_STATUSES = Object.freeze([ORDER_STATUS.RECEIVED, ORDER_STATUS.PACKED, ORDER_STATUS.SENT]);

/**
 * Statuses whose money is not the shop's.
 *
 * A cancelled order was never sold and a returned one came back; counting either as revenue would
 * inflate a day's takings by orders that produced nothing. They are excluded from every value and
 * quantity total here — and counted separately rather than dropped, because "we cancelled eleven
 * thousand rupees of orders this week" is itself an answer the owner wants.
 */
const VOID_STATUSES = Object.freeze([ORDER_STATUS.CANCELLED, ORDER_STATUS.RETURNED]);

const KNOWN_STATUSES = Object.freeze(Object.values(ORDER_STATUS));

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const shopDateFormatter = new Intl.DateTimeFormat("en-CA", {
  timeZone: SHOP_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

/**
 * The shop's calendar date for an instant, as `YYYY-MM-DD`.
 *
 * `formatToParts` rather than `format` because the assembled string is compared and sorted, and a
 * locale that decided to write the parts in a different order or with a different separator would
 * break the comparison silently.
 *
 * Returns `""` for anything unreadable. Callers must treat that as a problem, never as a date.
 *
 * @param {string|number|Date} value an ISO timestamp, epoch ms, or Date
 * @returns {string} `YYYY-MM-DD` in Asia/Kolkata, or `""`
 */
export const shopDateKey = (value) => {
  if (value === null || value === undefined || value === "") return "";
  // Already a bare calendar date. Re-parsing it would put it through a zone it never had.
  if (typeof value === "string" && DATE_ONLY.test(value.trim())) return normalizeReportDate(value.trim());
  const date = value instanceof Date ? value : new Date(typeof value === "number" ? value : String(value));
  if (!Number.isFinite(date.getTime())) return "";
  const parts = shopDateFormatter.formatToParts(date);
  const part = (type) => parts.find((entry) => entry.type === type)?.value || "";
  const key = `${part("year")}-${part("month")}-${part("day")}`;
  return DATE_ONLY.test(key) ? key : "";
};

/** Epoch milliseconds for a timestamp, or `null`. Never `0` as a stand-in for "unreadable". */
const asTime = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : null;
};

/** The shop's calendar Y/M/D for an instant, as an anchor for day arithmetic. */
const shopCalendarAnchorMs = (ms) => {
  const key = shopDateKey(ms);
  if (!key) return null;
  const [year, month, day] = key.split("-").map(Number);
  // Date.UTC is used purely as a calendar with no zone attached: the IST date is carried as a
  // UTC midnight so that adding and subtracting days can never cross a DST or offset seam.
  return Date.UTC(year, month - 1, day);
};

const anchorKey = (ms) => new Date(ms).toISOString().slice(0, 10);

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The date range every one of these reports is filtered by.
 *
 * Deliberately the same vocabulary as `reportRefresh.resolveReportDateRange` — `today`,
 * `yesterday`, `week`, `month`, `custom` — so the Report Center's existing range control drives it
 * unchanged, and `normalizeReportDate` is reused so a custom range is validated exactly one way in
 * this codebase.
 *
 * What is *not* reused is that function's preset arithmetic, which derives "today" from the host's
 * local calendar via `now.getFullYear()`. For a viewer on UTC at 00:30 IST that names yesterday,
 * and the owner would be shown an empty day while orders were arriving. The presets here are
 * computed on the shop's calendar instead.
 *
 * Throws rather than returning a broken range: a range that silently became today→today would show
 * a confident, wrong, small number, which is worse than a message.
 *
 * @throws {Error} when a custom range is missing, malformed, or ends before it starts
 */
export const resolveOrderReportRange = ({ range = "today", date_from, date_to } = {}, nowMs = Date.now()) => {
  if (range === "custom") {
    const from = normalizeReportDate(date_from);
    const to = normalizeReportDate(date_to);
    if (!from || !to) throw new Error("Select a valid Date From and Date To in DD/MM/YYYY format.");
    if (from > to) throw new Error("Date From cannot be after Date To.");
    return { range, date_from: from, date_to: to };
  }
  const today = shopCalendarAnchorMs(nowMs);
  if (today === null) throw new Error("The current time could not be read, so a report range cannot be worked out.");
  let start = today;
  let end = today;
  if (range === "yesterday") {
    start -= DAY_MS;
    end -= DAY_MS;
  } else if (range === "week") {
    // Monday-start, matching the rest of Report Center.
    start -= ((new Date(today).getUTCDay() + 6) % 7) * DAY_MS;
  } else if (range === "month") {
    const anchor = new Date(today);
    start = Date.UTC(anchor.getUTCFullYear(), anchor.getUTCMonth(), 1);
  }
  return { range, date_from: anchorKey(start), date_to: anchorKey(end) };
};

/** Whether a shop date key falls inside a resolved range. Both ends inclusive. */
export const isDateKeyInRange = (key, { date_from, date_to } = {}) => (
  Boolean(key) && Boolean(date_from) && Boolean(date_to) && key >= date_from && key <= date_to
);

/* ------------------------------------------------------------------ money and quantity ------- */

/**
 * A quantity in integer thousandths, or `null` when it is not a quantity.
 *
 * The schema requires `quantity > 0`, so a zero or negative here means a row arrived from
 * somewhere that is not this app's writer, and it is reported rather than added to a total.
 */
const quantityMilli = (value) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.round(parsed * 1000);
};

/**
 * An agreed rate, or `null` when the line was never priced.
 *
 * `Number.isFinite` and not `??` or `||`. A rate of **0** is a real answer — a replacement box sent
 * free after a complaint is a genuine zero-value line — and `agreed_rate ?? fallback` or
 * `Number(rate) || fallback` would both quietly replace it with something else. `CLAUDE.md` records
 * that trap for exactly these lot and line fields.
 *
 * `null` means nobody priced it, which is not zero either: it is an unknown, and it is reported as
 * a problem so that a value total which is short by an unpriced line says so.
 */
const agreedRate = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const paiseToRupees = (paise) => Math.round(paise) / 100;
const milliToQuantity = (milli) => Math.round(milli) / 1000;

/** One line's money in integer paise: rounded once, here, before anything is grouped. */
const linePaise = (milli, rate) => Math.round((milli / 1000) * rate * 100);

/**
 * The reporting value of one order, in rupees.
 *
 * The single money function for reports. Sums the same per-line rounded paise every report here
 * sums, so the number on a fulfilment row is the same number that row contributes to the by-date,
 * by-product and by-customer totals. Unpriced and unreadable lines contribute nothing — the
 * builders raise a problem for those so the shortfall is never silent.
 */
export const orderReportValue = (order) => paiseToRupees(
  (Array.isArray(order?.items) ? order.items : []).reduce((paise, line) => {
    const milli = quantityMilli(line?.quantity);
    const rate = agreedRate(line?.agreed_rate);
    if (milli === null || rate === null) return paise;
    return paise + linePaise(milli, rate);
  }, 0),
);

/* -------------------------------------------------------------------------- the source ------- */

const failure = (report, code, message, range = null) => ({
  report,
  ok: false,
  error: { code, message },
  range,
  rows: [],
  // Null, never 0. There is no total, so no total is offered — a tile cannot render a confident
  // zero out of a report that failed to build.
  summary: null,
  problems: [],
});

/** The raw list, whatever wrapper it arrived in, or `null` when it is not a list at all. */
const readOrderRows = (input) => {
  if (Array.isArray(input)) return input;
  // `listLocalCustomerOrders()` resolves to `{ orders: [...] }`, and to `null` off the desktop
  // shell. The wrapper is accepted; the null is not, because "no runtime" is not "no orders".
  if (input && typeof input === "object" && Array.isArray(input.orders)) return input.orders;
  return null;
};

/**
 * Who an order belongs to.
 *
 * `customer_id` is nullable by design — a first-time caller has no customer record, and the schema
 * says so — so grouping on it alone would throw every new customer into one nameless bucket. The
 * fallback keys on name and mobile together, never on name alone: two different people called Ram
 * are two customers, and merging them would invent a regular out of two strangers. An identified
 * customer and an unidentified one never merge, because their keys are in different namespaces.
 */
const customerKeyFor = (order) => {
  const id = canonicalInventoryId(order?.customer_id);
  if (id) return `id:${id}`;
  const name = String(order?.customer_name ?? "").trim().toLowerCase();
  const mobile = String(order?.customer_mobile ?? "").trim();
  return `walkin:${name}|${mobile}`;
};

const normalizeLines = (order, problems, reference) => {
  const lines = [];
  let unpriced = 0;
  let unreadable = 0;
  (Array.isArray(order?.items) ? order.items : []).forEach((line, index) => {
    const productKey = canonicalInventoryId(line?.product_id);
    const milli = quantityMilli(line?.quantity);
    if (!productKey || milli === null) {
      unreadable += 1;
      problems.push({
        code: ORDER_REPORT_PROBLEM.LINE_QUANTITY_UNREADABLE,
        orderId: reference.orderId,
        orderNo: reference.orderNo,
        message: `Line ${index + 1} of order ${reference.label} has no readable product or quantity, so it is missing from these totals.`,
      });
      return;
    }
    const rate = agreedRate(line?.agreed_rate);
    if (rate === null) {
      unpriced += 1;
      problems.push({
        code: ORDER_REPORT_PROBLEM.LINE_RATE_MISSING,
        orderId: reference.orderId,
        orderNo: reference.orderNo,
        message: `${line?.product_name || `Line ${index + 1}`} on order ${reference.label} has no agreed rate, so its quantity is counted but its value is not.`,
      });
    }
    lines.push({
      productKey,
      // Kept as written, never coerced. "004" and 4 are different products and `Number()` on an
      // entity id is the documented way this codebase has already lost rows.
      productId: String(line?.product_id ?? ""),
      productName: String(line?.product_name ?? "").trim() || "Unnamed product",
      unit: String(line?.unit ?? "").trim(),
      quantityMilli: milli,
      valuePaise: rate === null ? 0 : linePaise(milli, rate),
      unpriced: rate === null,
    });
  });
  return { lines, unpriced, unreadable };
};

/**
 * The one filtered collection every report on this screen is built from.
 *
 * Build it once and hand the same object to all four builders. Building it twice with different
 * arguments is the failure mode this module is shaped to prevent.
 *
 * @param {Array<object>|{orders: Array<object>}|null} input orders as SQLite hands them over
 * @param {{range?: string, date_from?: string, date_to?: string}} params the range control's state
 * @param {number} nowMs current time in epoch milliseconds
 */
export const buildOrderReportSource = (input, params = {}, nowMs = Date.now()) => {
  let range;
  try {
    range = resolveOrderReportRange(params, nowMs);
  } catch (error) {
    return {
      ok: false,
      error: { code: ORDER_REPORT_ERROR.RANGE_UNREADABLE, message: String(error?.message || error) },
      range: null,
      nowMs,
      orders: [],
      problems: [],
      excluded: { deleted: 0, outOfRange: 0, unreadable: 0 },
    };
  }

  const rows = readOrderRows(input);
  if (rows === null) {
    return {
      ok: false,
      error: {
        code: ORDER_REPORT_ERROR.ORDERS_UNREADABLE,
        message: "The orders on this device could not be read, so these reports are not showing nothing — they are showing nothing known. Reopen the screen, and restart the app if it stays this way.",
      },
      range,
      nowMs,
      orders: [],
      problems: [],
      excluded: { deleted: 0, outOfRange: 0, unreadable: 0 },
    };
  }

  const problems = [];
  const excluded = { deleted: 0, outOfRange: 0, unreadable: 0 };
  const orders = [];

  rows.forEach((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      excluded.unreadable += 1;
      problems.push({
        code: ORDER_REPORT_PROBLEM.ORDER_UNREADABLE,
        orderId: null,
        orderNo: "",
        message: `Row ${index + 1} of the order list is not an order and has been left out of these totals.`,
      });
      return;
    }
    // Deleted orders vanish, and quietly: a deletion is a decision somebody took, not a fault.
    // `list_customer_orders_at` in local_db.rs already filters these in SQL and does not even emit
    // the column, so this only ever fires for rows that reached here from somewhere else.
    if (String(raw.deleted_at ?? "").trim()) {
      excluded.deleted += 1;
      return;
    }

    const orderId = canonicalInventoryId(raw.id);
    const orderNo = String(raw.order_no ?? "").trim();
    const label = orderNo || orderId || `#${index + 1}`;
    const reference = { orderId: orderId || null, orderNo, label };

    const orderedAtMs = asTime(raw.created_at);
    const orderedOn = shopDateKey(raw.created_at);
    if (orderedAtMs === null || !orderedOn) {
      // Cannot be placed on a day, so it cannot honestly be inside or outside the range. It is
      // excluded from all four reports at once — from the one shared source, so they stay in
      // agreement — and named, so the gap is visible rather than a total quietly being short.
      excluded.unreadable += 1;
      problems.push({
        code: ORDER_REPORT_PROBLEM.ORDER_DATE_UNREADABLE,
        orderId: reference.orderId,
        orderNo,
        message: `Order ${label} has no readable date, so it could not be placed in this range and is missing from these totals.`,
      });
      return;
    }
    if (!isDateKeyInRange(orderedOn, range)) {
      excluded.outOfRange += 1;
      return;
    }

    const status = String(raw.status ?? "").trim();
    const statusKnown = KNOWN_STATUSES.includes(status);
    if (!statusKnown) {
      // Not silently voided and not silently trusted. It stays in the counts, because it is a real
      // order somebody took, and it is named, because the database refuses such a status and so
      // something outside this app wrote it.
      problems.push({
        code: ORDER_REPORT_PROBLEM.ORDER_STATUS_UNKNOWN,
        orderId: reference.orderId,
        orderNo,
        message: `Order ${label} has an unrecognised status (${status || "blank"}). It is counted here, but what happened to it is unknown.`,
      });
    }

    const { lines, unpriced, unreadable } = normalizeLines(raw, problems, reference);
    // The board's own presentation, reused rather than re-derived, so a fulfilment row and the
    // Orders screen describe the same order in the same words.
    const presented = presentOrder(raw, nowMs);

    orders.push({
      raw,
      id: orderId,
      orderNo,
      label,
      source: String(raw.source ?? "").trim() || "PHONE",
      status,
      statusKnown,
      // Cancelled and returned money is never the shop's. Everything else counts.
      counted: !VOID_STATUSES.includes(status),
      open: OPEN_STATUSES.includes(status),
      customerKey: customerKeyFor(raw),
      customerId: String(raw.customer_id ?? "").trim(),
      customerName: String(raw.customer_name ?? "").trim() || "Walk-in customer",
      customerMobile: String(raw.customer_mobile ?? "").trim(),
      orderedOn,
      orderedAtMs,
      lines,
      unpricedLines: unpriced,
      unreadableLines: unreadable,
      valuePaise: lines.reduce((total, line) => total + line.valuePaise, 0),
      presented,
    });
  });

  return { ok: true, error: null, range, nowMs, orders, problems, excluded };
};

/** A source that a builder can work from, or the failure to report instead. */
const sourceFailure = (report, source) => {
  if (!source || typeof source !== "object" || !Array.isArray(source.orders)) {
    return failure(
      report,
      ORDER_REPORT_ERROR.SOURCE_UNREADABLE,
      "This report was not given an order source to build from, so it has no figures to show.",
      null,
    );
  }
  if (!source.ok) return failure(report, source.error?.code || ORDER_REPORT_ERROR.ORDERS_UNREADABLE, source.error?.message || "The orders could not be read.", source.range || null);
  return null;
};

/** Counts that every summary carries, so a short total always says why it is short. */
const provenance = (source, orders) => ({
  unreadableOrders: source.excluded.unreadable,
  deletedOrders: source.excluded.deleted,
  unknownStatus: orders.filter((order) => !order.statusKnown).length,
  unpricedLines: orders.reduce((total, order) => total + order.unpricedLines, 0),
  problems: source.problems.length,
});

/* ------------------------------------------------------------------------ 1. by date --------- */

/**
 * What came in each day, what it was worth, and what became of it.
 *
 * Grouped on the shop's calendar day, so an order taken at 11:30pm belongs to the day the shop
 * took it in and not to the day the reader's computer thinks it is.
 *
 * Every row's status counters — delivered, cancelled, returned, open, unknown — add up to that
 * row's `orders`. That is deliberate and asserted in the suite: a status this module did not
 * account for would otherwise make an order disappear from every counter while still being counted
 * once, and nothing on screen would show that it had.
 */
export const buildOrdersByDateReport = (source) => {
  const refuse = sourceFailure(ORDER_REPORT.BY_DATE, source);
  if (refuse) return refuse;

  const days = new Map();
  for (const order of source.orders) {
    const row = days.get(order.orderedOn) || {
      date: order.orderedOn,
      dateLabel: formatIndianReportDate(order.orderedOn),
      orders: 0,
      valuePaise: 0,
      delivered: 0,
      cancelled: 0,
      returned: 0,
      open: 0,
      unknownStatus: 0,
      cancelledValuePaise: 0,
      unpricedLines: 0,
    };
    row.orders += 1;
    row.unpricedLines += order.unpricedLines;
    if (order.counted) row.valuePaise += order.valuePaise;
    else row.cancelledValuePaise += order.valuePaise;
    if (order.status === ORDER_STATUS.DELIVERED) row.delivered += 1;
    else if (order.status === ORDER_STATUS.CANCELLED) row.cancelled += 1;
    else if (order.status === ORDER_STATUS.RETURNED) row.returned += 1;
    else if (order.open) row.open += 1;
    else row.unknownStatus += 1;
    days.set(order.orderedOn, row);
  }

  const rows = [...days.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map(({ valuePaise, cancelledValuePaise, ...row }) => ({
      ...row,
      value: paiseToRupees(valuePaise),
      cancelledValue: paiseToRupees(cancelledValuePaise),
    }));

  // Reduced from the rows themselves, not from a second pass over the orders. A summary derived
  // from a different collection than its table is the disagreement this module exists to avoid.
  const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
  return {
    report: ORDER_REPORT.BY_DATE,
    ok: true,
    error: null,
    range: source.range,
    rows,
    summary: {
      days: rows.length,
      orders: total("orders"),
      value: paiseToRupees(rows.reduce((sum, row) => sum + Math.round(row.value * 100), 0)),
      cancelledValue: paiseToRupees(rows.reduce((sum, row) => sum + Math.round(row.cancelledValue * 100), 0)),
      delivered: total("delivered"),
      cancelled: total("cancelled"),
      returned: total("returned"),
      open: total("open"),
      ...provenance(source, source.orders),
    },
    problems: source.problems,
  };
};

/* --------------------------------------------------------------------- 2. by product ---------- */

/**
 * How much of each thing was ordered. The mandi list.
 *
 * Cancelled and returned orders are out of the quantity as well as out of the value — buying
 * tomorrow's fruit for an order the customer cancelled yesterday is the specific mistake this row
 * is meant to prevent — but their quantity is carried in `cancelledQuantity` rather than dropped,
 * so a product whose orders keep falling through is visible instead of merely absent.
 *
 * Grouped on `canonicalInventoryId(product_id)`. Ids are opaque strings: `"004"` and `4` are
 * different products, and `Number()` on either side of this grouping is how this codebase once
 * emptied the Inventory table while every summary tile above it stayed correct.
 */
export const buildOrdersByProductReport = (source) => {
  const refuse = sourceFailure(ORDER_REPORT.BY_PRODUCT, source);
  if (refuse) return refuse;

  const products = new Map();
  for (const order of source.orders) {
    for (const line of order.lines) {
      const row = products.get(line.productKey) || {
        productKey: line.productKey,
        productId: line.productId,
        productName: line.productName,
        unit: line.unit,
        quantityMilli: 0,
        valuePaise: 0,
        cancelledQuantityMilli: 0,
        unpricedLines: 0,
        orderKeys: new Set(),
        customerKeys: new Set(),
        lastOrderedOn: "",
      };
      if (!row.unit && line.unit) row.unit = line.unit;
      if (order.counted) {
        row.quantityMilli += line.quantityMilli;
        row.valuePaise += line.valuePaise;
        if (line.unpriced) row.unpricedLines += 1;
        row.orderKeys.add(order.id || order.label);
        row.customerKeys.add(order.customerKey);
        if (order.orderedOn > row.lastOrderedOn) row.lastOrderedOn = order.orderedOn;
      } else {
        row.cancelledQuantityMilli += line.quantityMilli;
      }
      products.set(line.productKey, row);
    }
  }

  const rows = [...products.values()]
    .map(({ quantityMilli: milli, cancelledQuantityMilli, valuePaise, orderKeys, customerKeys, ...row }) => ({
      ...row,
      quantity: milliToQuantity(milli),
      cancelledQuantity: milliToQuantity(cancelledQuantityMilli),
      value: paiseToRupees(valuePaise),
      orders: orderKeys.size,
      customers: customerKeys.size,
    }))
    // Most-wanted first: this list is read top-down while writing out what to buy.
    .sort((left, right) => right.quantity - left.quantity || left.productName.localeCompare(right.productName));

  return {
    report: ORDER_REPORT.BY_PRODUCT,
    ok: true,
    error: null,
    range: source.range,
    rows,
    summary: {
      products: rows.length,
      quantity: milliToQuantity(rows.reduce((sum, row) => sum + Math.round(row.quantity * 1000), 0)),
      cancelledQuantity: milliToQuantity(rows.reduce((sum, row) => sum + Math.round(row.cancelledQuantity * 1000), 0)),
      value: paiseToRupees(rows.reduce((sum, row) => sum + Math.round(row.value * 100), 0)),
      // Orders with at least one countable line. An order whose every line was unreadable, or which
      // has no lines at all, is in the by-date count and not in this one; the difference is the
      // point of `unreadableOrders` and `problems` below.
      orders: new Set(source.orders.filter((order) => order.counted && order.lines.length > 0).map((order) => order.id || order.label)).size,
      ...provenance(source, source.orders),
    },
    problems: source.problems,
  };
};

/** The row for one product, compared the only safe way. Never `rows.find(r => r.productId == id)`. */
export const findProductReportRow = (rows, productId) => (
  (Array.isArray(rows) ? rows : []).find((row) => inventoryIdsEqual(row?.productKey ?? row?.productId, productId)) || null
);

/* -------------------------------------------------------------------- 3. by customer ---------- */

/**
 * Who orders, how often, how much.
 *
 * Sorted by value, because the question behind this report is which customers are worth keeping.
 * `identified` is carried on every row: an unidentified regular — someone who has ordered nine
 * times and still has no customer record — is a specific thing the owner can act on, and it would
 * be invisible if the row looked the same as an identified one.
 */
export const buildOrdersByCustomerReport = (source) => {
  const refuse = sourceFailure(ORDER_REPORT.BY_CUSTOMER, source);
  if (refuse) return refuse;

  const customers = new Map();
  for (const order of source.orders) {
    const row = customers.get(order.customerKey) || {
      customerKey: order.customerKey,
      customerId: order.customerId,
      identified: Boolean(canonicalInventoryId(order.customerId)),
      customerName: order.customerName,
      customerMobile: order.customerMobile,
      orders: 0,
      valuePaise: 0,
      cancelled: 0,
      cancelledValuePaise: 0,
      firstOrderedOn: order.orderedOn,
      lastOrderedOn: order.orderedOn,
      unpricedLines: 0,
    };
    row.orders += 1;
    row.unpricedLines += order.unpricedLines;
    if (!row.customerMobile && order.customerMobile) row.customerMobile = order.customerMobile;
    if (order.counted) {
      row.valuePaise += order.valuePaise;
    } else {
      row.cancelled += 1;
      row.cancelledValuePaise += order.valuePaise;
    }
    if (order.orderedOn < row.firstOrderedOn) row.firstOrderedOn = order.orderedOn;
    if (order.orderedOn > row.lastOrderedOn) row.lastOrderedOn = order.orderedOn;
    customers.set(order.customerKey, row);
  }

  const rows = [...customers.values()]
    .map(({ valuePaise, cancelledValuePaise, ...row }) => ({
      ...row,
      value: paiseToRupees(valuePaise),
      cancelledValue: paiseToRupees(cancelledValuePaise),
      // Averaged over every order this customer placed, cancellations included, because "what is an
      // order from this person usually worth" is a question about the person and not about the
      // subset that completed.
      averageOrderValue: row.orders > 0 ? paiseToRupees(Math.round(valuePaise / row.orders)) : 0,
    }))
    .sort((left, right) => right.value - left.value || left.customerName.localeCompare(right.customerName));

  const totalOrders = rows.reduce((sum, row) => sum + row.orders, 0);
  const totalPaise = rows.reduce((sum, row) => sum + Math.round(row.value * 100), 0);
  return {
    report: ORDER_REPORT.BY_CUSTOMER,
    ok: true,
    error: null,
    range: source.range,
    rows,
    summary: {
      customers: rows.length,
      identifiedCustomers: rows.filter((row) => row.identified).length,
      orders: totalOrders,
      value: paiseToRupees(totalPaise),
      cancelled: rows.reduce((sum, row) => sum + row.cancelled, 0),
      cancelledValue: paiseToRupees(rows.reduce((sum, row) => sum + Math.round(row.cancelledValue * 100), 0)),
      averageOrderValue: totalOrders > 0 ? paiseToRupees(Math.round(totalPaise / totalOrders)) : 0,
      ...provenance(source, source.orders),
    },
    problems: source.problems,
  };
};

/* --------------------------------------------------------------------- 4. fulfilment ---------- */

/**
 * The individual orders behind the three summaries above.
 *
 * Newest first, and every row carries the things somebody chasing an order needs in one line:
 * where it is, how old it is, who is carrying it, and which bill it became. `presentOrder` supplies
 * the presentation so this row and the Orders board never describe the same order differently; its
 * `value` is replaced by the report's per-line-rounded figure, because the board rounds once at the
 * point of display and a report cannot — see the note at the top of this file.
 */
export const buildOrderFulfilmentReport = (source) => {
  const refuse = sourceFailure(ORDER_REPORT.FULFILMENT, source);
  if (refuse) return refuse;

  const rows = source.orders
    .map((order) => ({
      id: order.id,
      orderNo: order.orderNo,
      orderedOn: order.orderedOn,
      orderedOnLabel: formatIndianReportDate(order.orderedOn),
      orderedAtMs: order.orderedAtMs,
      ageMs: Math.max(0, source.nowMs - order.orderedAtMs),
      // Hours to two decimals: milliseconds / 3,600,000, kept as an integer of hundredths so
      // the rounding happens once rather than at each of two divisions.
      ageHours: Math.round(Math.max(0, source.nowMs - order.orderedAtMs) / 36000) / 100,
      source: order.source,
      status: order.status,
      statusKnown: order.statusKnown,
      open: order.open,
      counted: order.counted,
      reservation: order.presented.reservation,
      customerId: order.customerId,
      customerName: order.customerName,
      customerMobile: order.customerMobile,
      carrier: order.presented.carrier,
      carrierReference: order.presented.carrierReference,
      trackingUrl: order.presented.trackingUrl,
      invoiceNo: order.presented.invoiceNo,
      billed: order.presented.billed,
      paymentState: order.presented.paymentState,
      paymentWarning: order.presented.paymentWarning,
      warning: order.presented.warning,
      lines: order.lines.length,
      unpricedLines: order.unpricedLines,
      value: paiseToRupees(order.valuePaise),
      countedValue: order.counted ? paiseToRupees(order.valuePaise) : 0,
    }))
    .sort((left, right) => right.orderedAtMs - left.orderedAtMs || String(right.orderNo).localeCompare(String(left.orderNo)));

  const count = (predicate) => rows.filter(predicate).length;
  const openRows = rows.filter((row) => row.open);
  return {
    report: ORDER_REPORT.FULFILMENT,
    ok: true,
    error: null,
    range: source.range,
    rows,
    summary: {
      orders: rows.length,
      value: paiseToRupees(rows.reduce((sum, row) => sum + Math.round(row.countedValue * 100), 0)),
      cancelledValue: paiseToRupees(rows.filter((row) => !row.counted).reduce((sum, row) => sum + Math.round(row.value * 100), 0)),
      delivered: count((row) => row.status === ORDER_STATUS.DELIVERED),
      cancelled: count((row) => row.status === ORDER_STATUS.CANCELLED),
      returned: count((row) => row.status === ORDER_STATUS.RETURNED),
      open: openRows.length,
      // Parcels that are out, or about to be, with the money question unanswered. This is the list
      // the owner works from when chasing payment, so it is a headline figure and not a filter.
      awaitingPayment: count((row) => row.open && Boolean(row.paymentWarning)),
      unbilled: count((row) => row.status === ORDER_STATUS.SENT && !row.billed),
      // Null, not 0, when nothing is open: "the oldest open order is 0 hours old" is a sentence
      // about an order that does not exist.
      oldestOpenAgeMs: openRows.length > 0 ? Math.max(...openRows.map((row) => row.ageMs)) : null,
      ...provenance(source, source.orders),
    },
    problems: source.problems,
  };
};

/* ------------------------------------------------------------------------- all four ----------- */

/**
 * All four reports, from one source, built once.
 *
 * The intended entry point. Calling the builders separately is supported, but this is the shape
 * that makes it impossible to hand two of them differently-filtered inputs by accident.
 */
export const buildOrderReports = (input, params = {}, nowMs = Date.now()) => {
  const source = buildOrderReportSource(input, params, nowMs);
  return {
    ok: source.ok,
    error: source.error,
    range: source.range,
    problems: source.problems,
    excluded: source.excluded,
    [ORDER_REPORT.BY_DATE]: buildOrdersByDateReport(source),
    [ORDER_REPORT.BY_PRODUCT]: buildOrdersByProductReport(source),
    [ORDER_REPORT.BY_CUSTOMER]: buildOrdersByCustomerReport(source),
    [ORDER_REPORT.FULFILMENT]: buildOrderFulfilmentReport(source),
  };
};

/**
 * One sentence for the screen, or `""` when there is nothing to say.
 *
 * A report with `error` set has no figures at all; a report with `problems` has figures that are
 * knowingly incomplete. Both must reach the reader — the second one especially, because it is the
 * one that otherwise looks like a normal, slightly small total.
 */
export const describeOrderReportError = (report) => {
  if (report?.error?.message) return report.error.message;
  const problems = Array.isArray(report?.problems) ? report.problems : [];
  if (problems.length === 0) return "";
  if (problems.length === 1) return problems[0].message;
  return `${problems.length} orders or order lines could not be fully read, so these figures are incomplete: ${problems[0].message}`;
};
