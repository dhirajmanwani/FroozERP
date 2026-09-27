/**
 * The Owner's daily line in the bell: how many bills were cancelled or edited today, and by whom.
 *
 * ## Where the events come from
 *
 * - **Cloud** (`GET /sales-report/change-events?since=<ISO UTC>`): every counter of the branch,
 *   with the approver's name. Read with {@link normalizeCloudChangeEvents}.
 * - **This counter** (`listLocalPosSales()`, offline or LOCAL_ONLY): the last 200 bills on this
 *   device. Read with {@link normalizeLocalChangeRows}; the bell then says "this counter only".
 *
 * ## Rules this module keeps
 *
 * 1. **The day is the device's local day.** Events are stamped in UTC; each is bucketed with
 *    `localDateKey`, never `toISOString()`, so a bill cancelled at 01:00 IST is today's, not
 *    yesterday's. A timestamp with no zone is UTC (that is how both databases write it).
 * 2. **A failed read is never "no changes".** A bad payload throws; the caller passes the failure to
 *    {@link saleChangeDigestBellItems}, which returns one loud error row and no count at all.
 *    An amount that cannot be read is said as such, never as ₹0.
 * 3. **Ids are opaque strings.** A sale id or invoice number is never passed through `Number()`.
 * 4. **No clock inside.** The day key and the stamp time are parameters.
 */

import { NOTIFICATION_SEVERITY } from "./notificationCenter.js";
import { describeDay, isDateKey, localDateKey } from "./paymentsDue.js";
import { canonicalInventoryId } from "./stockInventory.js";

export const SALE_CHANGE_ACTION = Object.freeze({ CANCEL: "cancel", EDIT: "edit" });

export const SALE_CHANGES_BELL_SOURCE = "Sales";
/** The key the "could not be read" row always occupies, so a later good read can retract it. */
export const SALE_CHANGES_UNREADABLE_KEY = "sale-changes:unreadable";
export const SALE_CHANGE_DIGEST_STATUS = Object.freeze({ OK: "ok", UNREADABLE: "unreadable" });
export const SALE_CHANGE_SCOPE = Object.freeze({ ALL: "all", THIS_COUNTER: "this-counter" });

/** Thrown when the events cannot be trusted. `code` lets a caller tell it from a network error. */
export class SaleChangeEventsError extends Error {
  constructor(message) {
    super(message);
    this.name = "SaleChangeEventsError";
    this.code = "SALE_CHANGE_EVENTS_UNREADABLE";
  }
}

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** A money field as a 2dp number, or `null` when it cannot be read. Numeric strings (Postgres) count. */
const amountOf = (value) => {
  const amount = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
};

const TIMESTAMP = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|z|[+-]\d{2}(?::?\d{2})?)?$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Epoch milliseconds for a stored timestamp, or `null`.
 *
 * "2026-09-27 03:10:00" and "2026-09-27T03:10:00.123" (no zone) are UTC. Postgres offsets such as
 * "+00" or "+0530" are accepted. A finite number is taken as epoch ms.
 */
export const parseUtcTimestamp = (value) => {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (!raw) return null;
  if (DATE_ONLY.test(raw)) {
    const ms = Date.parse(`${raw}T00:00:00Z`);
    return Number.isFinite(ms) ? ms : null;
  }
  const match = TIMESTAMP.exec(raw);
  if (!match) return null;
  const [, day, hourMinute, seconds = "00", fraction = "", zoneRaw = ""] = match;
  let zone = "Z";
  if (zoneRaw && zoneRaw.toUpperCase() !== "Z") {
    const digits = zoneRaw.slice(1).replace(":", "");
    zone = `${zoneRaw[0]}${digits.slice(0, 2)}:${(digits.slice(2) || "00").padEnd(2, "0")}`;
  }
  const millis = fraction ? `.${fraction.slice(0, 3).padEnd(3, "0")}` : "";
  const ms = Date.parse(`${day}T${hourMinute}:${seconds}${millis}${zone}`);
  return Number.isFinite(ms) ? ms : null;
};

/**
 * The body of `GET /sales-report/change-events` as events.
 *
 * Throws {@link SaleChangeEventsError} when the body is not `{events: [...]}`, or an event has no
 * known action or no readable time: the server promises both, so a missing one is a contract
 * breach and must show as an error, not be skipped into a smaller count.
 *
 * @returns {Array<{action: string, saleId: string, invoiceNo: string, oldTotal: number|null,
 *   newTotal: number|null, reason: string, atMs: number, byName: string, approvedByName: string}>}
 */
export const normalizeCloudChangeEvents = (payload) => {
  const events = payload && typeof payload === "object" ? payload.events : undefined;
  if (!Array.isArray(events)) throw new SaleChangeEventsError("The bill changes list from the server could not be read.");
  return events.map((event, index) => {
    if (!event || typeof event !== "object") throw new SaleChangeEventsError(`Bill change ${index + 1} from the server could not be read.`);
    const action = text(event.action).toLowerCase();
    if (action !== SALE_CHANGE_ACTION.CANCEL && action !== SALE_CHANGE_ACTION.EDIT) {
      throw new SaleChangeEventsError(`Bill change ${index + 1} from the server has no cancel or edit action.`);
    }
    const atMs = parseUtcTimestamp(event.at);
    if (atMs === null) throw new SaleChangeEventsError(`Bill change ${index + 1} from the server has no readable time.`);
    return {
      action,
      saleId: canonicalInventoryId(event.sale_id),
      invoiceNo: canonicalInventoryId(event.invoice_no),
      oldTotal: amountOf(event.old_total),
      newTotal: amountOf(event.new_total),
      reason: text(event.reason),
      atMs,
      byName: text(event.by_name),
      approvedByName: text(event.approved_by_name),
    };
  });
};

/**
 * This counter's bills (`listLocalPosSales()` snapshots, or the invoices mapped from them) as
 * events.
 *
 * A CANCELLED bill is one cancel at `cancelled_at` (falling back to `updated_at`), with the bill
 * total as its old total. Any other bill with an `edit_reason` is one edit at `updated_at`, with the
 * bill total as its new total; its old total is not kept locally and is `null`. A cancelled bill
 * that had been edited counts once, as a cancel: the cancel overwrote the edit's time.
 *
 * Local rows carry user ids, not names; `userNamesById` (canonical id -> name, Map or object) turns
 * them into names, and an id with no name is shown as the id. There is no approver locally.
 *
 * Throws {@link SaleChangeEventsError} when `invoices` is not a list or a changed bill has no
 * readable time.
 */
export const normalizeLocalChangeRows = (invoices, { userNamesById } = {}) => {
  if (!Array.isArray(invoices)) throw new SaleChangeEventsError("This counter's bills could not be read.");
  const nameFor = (userId) => {
    const id = canonicalInventoryId(userId);
    if (!id) return "";
    const name = userNamesById instanceof Map
      ? userNamesById.get(id)
      : (userNamesById && typeof userNamesById === "object" ? userNamesById[id] : undefined);
    return text(name) || id;
  };
  const events = [];
  invoices.forEach((row, index) => {
    const invoice = row && typeof row === "object" && row.invoice && typeof row.invoice === "object" ? row.invoice : row;
    if (!invoice || typeof invoice !== "object") throw new SaleChangeEventsError(`Bill ${index + 1} on this counter could not be read.`);
    const status = text(invoice.status || invoice.sale_status).toUpperCase();
    const editReason = text(invoice.edit_reason);
    const cancelled = status === "CANCELLED";
    if (!cancelled && !editReason) return;
    const saleId = canonicalInventoryId(invoice.id || invoice.invoice_global_id || invoice.sale_id);
    const invoiceNo = canonicalInventoryId(invoice.server_invoice_no || invoice.offline_invoice_ref || invoice.invoice_no);
    // net_total is the stored column; total_amount is what localSnapshotToInvoice renames it to.
    const total = amountOf(invoice.net_total ?? invoice.total_amount);
    const atMs = cancelled
      ? (parseUtcTimestamp(invoice.cancelled_at) ?? parseUtcTimestamp(invoice.updated_at))
      : parseUtcTimestamp(invoice.updated_at);
    if (atMs === null) {
      throw new SaleChangeEventsError(`Bill ${invoiceNo || saleId || index + 1} on this counter was ${cancelled ? "cancelled" : "edited"} at a time that could not be read.`);
    }
    events.push(cancelled
      ? {
        action: SALE_CHANGE_ACTION.CANCEL,
        saleId,
        invoiceNo,
        oldTotal: total,
        newTotal: null,
        reason: text(invoice.cancellation_reason),
        atMs,
        byName: nameFor(invoice.cancelled_by ?? invoice.user_id),
        approvedByName: "",
      }
      : {
        action: SALE_CHANGE_ACTION.EDIT,
        saleId,
        invoiceNo,
        oldTotal: null,
        newTotal: total,
        reason: editReason,
        atMs,
        byName: nameFor(invoice.user_id),
        approvedByName: "",
      });
  });
  return events;
};

const UNKNOWN_PERSON = "Unknown";

/**
 * The day's counts.
 *
 * `cancelledAmount` is the sum of the old totals of the day's cancelled bills, rounded to 2dp, and
 * is `null` when any of them could not be read (`cancelledAmountUnreadable` says how many) — a
 * partial sum would understate the day without saying so.
 *
 * `byPerson` is sorted by count (most first), then name. An event with no name is "Unknown".
 *
 * Throws when `events` is not a list or `dateKey` is not a real day.
 */
export const buildSaleChangeDigest = ({ events, dateKey } = {}) => {
  if (!Array.isArray(events)) throw new SaleChangeEventsError("The bill changes could not be read.");
  if (!isDateKey(dateKey)) throw new SaleChangeEventsError("The day for the bill changes summary is not a real date.");
  const today = events.filter((event) => (
    event
    && typeof event.atMs === "number"
    && Number.isFinite(event.atMs)
    && localDateKey(new Date(event.atMs)) === dateKey
  ));
  let cancelledCount = 0;
  let editedCount = 0;
  let cancelledCents = 0;
  let cancelledAmountUnreadable = 0;
  let approvedCancelledCount = 0;
  let approvedEditedCount = 0;
  const people = new Map();
  for (const event of today) {
    const isCancel = event.action === SALE_CHANGE_ACTION.CANCEL;
    const isEdit = event.action === SALE_CHANGE_ACTION.EDIT;
    if (!isCancel && !isEdit) continue;
    const approved = Boolean(text(event.approvedByName));
    if (isCancel) {
      cancelledCount += 1;
      if (typeof event.oldTotal === "number" && Number.isFinite(event.oldTotal)) cancelledCents += Math.round(event.oldTotal * 100);
      else cancelledAmountUnreadable += 1;
      if (approved) approvedCancelledCount += 1;
    } else {
      editedCount += 1;
      if (approved) approvedEditedCount += 1;
    }
    const name = text(event.byName) || UNKNOWN_PERSON;
    const person = people.get(name) || { name, count: 0, cancelled: 0, edited: 0 };
    person.count += 1;
    if (isCancel) person.cancelled += 1;
    else person.edited += 1;
    people.set(name, person);
  }
  const byPerson = [...people.values()].sort((left, right) => (
    right.count - left.count || left.name.localeCompare(right.name)
  ));
  return {
    dateKey,
    totalCount: cancelledCount + editedCount,
    cancelledCount,
    cancelledAmount: cancelledAmountUnreadable > 0 ? null : cancelledCents / 100,
    cancelledAmountUnreadable,
    editedCount,
    approvedCount: approvedCancelledCount + approvedEditedCount,
    approvedCancelledCount,
    approvedEditedCount,
    byPerson,
  };
};

const RUPEES_AND_PAISE = new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

/** "₹1,240.00" — always two decimals. "" for a value that is not a finite number. */
export const formatInr = (value) => (
  typeof value === "number" && Number.isFinite(value) ? RUPEES_AND_PAISE.format(Math.round(value * 100) / 100) : ""
);

const bills = (count) => `${count} bill${count === 1 ? "" : "s"}`;

const failureText = (failure) => {
  if (failure instanceof Error) return text(failure.message);
  if (typeof failure === "string") return text(failure);
  if (failure && typeof failure === "object") return text(failure.message);
  return failure ? "The bill changes could not be read." : "";
};

/**
 * The digest as bell rows, in the shape the bell publisher consumes: `{status, message, keys,
 * items}`, each item ready for `createNotification`.
 *
 * - No changes: no items (status ok).
 * - Changes: one INFO item keyed `sale-changes:<dateKey>`, titled like
 *   "Today: 3 bills cancelled (₹1,240.00), 1 edited", message like "By Ravi (3), Asha (1)", then
 *   " · 2 approved" when any were approved, then " · this counter only" for the local source.
 *   Amount changes change the title, so the publisher re-raises it.
 * - `failure` given, or no digest: one sticky ERROR item keyed `sale-changes:unreadable` and
 *   status unreadable — never a count. The caller should not retract the day's row then.
 *
 * @param {object|null} digest from {@link buildSaleChangeDigest}
 * @param {object} options
 * @param {string} options.dateKey the local day the digest is for
 * @param {string|Error} [options.failure] the load error, when the read failed
 * @param {"all"|"this-counter"} [options.scope] where the events came from (default "all")
 * @param {string} [options.todayKey] today's local day; when it differs from `dateKey` the title
 *   names the day ("26 Sep") instead of "Today"
 * @param {number} [options.nowMs] stamps the rows; omitted, `createNotification` stamps them
 */
export const saleChangeDigestBellItems = (digest, {
  dateKey,
  failure,
  scope = SALE_CHANGE_SCOPE.ALL,
  todayKey,
  nowMs,
} = {}) => {
  const at = typeof nowMs === "number" && Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : undefined;
  const thisCounter = scope === SALE_CHANGE_SCOPE.THIS_COUNTER;
  const scopeSuffix = thisCounter ? " · this counter only" : "";
  const failed = failureText(failure);
  const usable = digest && typeof digest === "object" && Number.isInteger(digest.totalCount) && isDateKey(dateKey);
  if (failed || !usable) {
    const message = `${failed || "The bill changes could not be read."} Cancelled and edited bills are not counted until this is read.${scopeSuffix}`;
    return {
      status: SALE_CHANGE_DIGEST_STATUS.UNREADABLE,
      message,
      keys: [SALE_CHANGES_UNREADABLE_KEY],
      items: [{
        id: SALE_CHANGES_UNREADABLE_KEY,
        dedupeKey: SALE_CHANGES_UNREADABLE_KEY,
        severity: NOTIFICATION_SEVERITY.ERROR,
        title: "Today's cancelled and edited bills could not be read",
        message,
        source: SALE_CHANGES_BELL_SOURCE,
        at,
        sticky: true,
      }],
    };
  }
  if (digest.totalCount === 0) return { status: SALE_CHANGE_DIGEST_STATUS.OK, message: "", keys: [], items: [] };

  const dayLabel = isDateKey(todayKey) && todayKey !== dateKey ? describeDay(dateKey, todayKey) : "Today";
  const parts = [];
  if (digest.cancelledCount > 0) {
    const amount = formatInr(digest.cancelledAmount);
    parts.push(`${bills(digest.cancelledCount)} cancelled (${amount || "amount could not be read"})`);
  }
  if (digest.editedCount > 0) {
    parts.push(parts.length ? `${digest.editedCount} edited` : `${bills(digest.editedCount)} edited`);
  }
  const people = (Array.isArray(digest.byPerson) ? digest.byPerson : []).map((person) => `${person.name} (${person.count})`);
  const approvals = digest.approvedCount > 0 ? ` · ${digest.approvedCount} approved` : "";
  const key = `sale-changes:${dateKey}`;
  return {
    status: SALE_CHANGE_DIGEST_STATUS.OK,
    message: "",
    keys: [key],
    items: [{
      id: key,
      dedupeKey: key,
      severity: NOTIFICATION_SEVERITY.INFO,
      title: `${dayLabel}: ${parts.join(", ")}`,
      message: `By ${people.join(", ")}${approvals}${scopeSuffix}`,
      source: SALE_CHANGES_BELL_SOURCE,
      at,
      sticky: false,
    }],
  };
};
