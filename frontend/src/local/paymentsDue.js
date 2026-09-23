/**
 * Today's payments: who to collect from and who to pay, as the popup, the bell and the dues panel
 * show them.
 *
 * ## What was asked
 *
 * On 23 Sep 2026 the owner asked for date-based payment reminders, and on that day a popup in the
 * app: *"aaj payment maangna he abc customer se, ya xyz supplier ko aaj payment dena he"*. The list
 * itself is worked out by the server (`GET /api/ai/payments-due?date=YYYY-MM-DD`, read-only); this
 * module turns that answer into the lines he reads and the requests his buttons send.
 *
 * ## Rules this module keeps
 *
 * 1. **The day is the device's local day.** The laptop is IST; the server may be UTC. Between
 *    00:00 and 05:30 IST `toISOString()` still names yesterday, so a popup keyed on it would show
 *    yesterday's list after midnight and remember a dismissal against the wrong day.
 *    {@link localDateKey} reads the local calendar fields and nothing else.
 * 2. **A failed read is never "nothing due".** Every builder returns a `status`, and a failure is
 *    `unreadable` with a message that says the list could not be read. The popup does not open on
 *    a failure, and the bell carries one loud row instead — CLAUDE.md: errors must never render as
 *    zero.
 * 3. **Ids are opaque strings.** A customer or supplier id is compared with `canonicalInventoryId`
 *    only, and is never passed through `Number()`: "004" and 4 are different accounts.
 * 4. **Nothing here sends anything.** The requests built here create or re-date a reminder row.
 *    The only outward-facing thing a row can carry is the existing prepared-message `wa.me` link
 *    from `frostDuesOutreach.js`, which the owner taps and sends himself.
 * 5. **No clock inside.** Today's date key and the current time are parameters, so every cutoff is
 *    testable.
 */

import { NOTIFICATION_SEVERITY } from "./notificationCenter.js";
import { canonicalInventoryId } from "./stockInventory.js";

/** Whether the list was read. The caller switches on this, never on how many rows came back. */
export const PAYMENTS_DUE_STATUS = Object.freeze({
  OK: "ok",
  UNREADABLE: "unreadable",
});

/** The two kinds of row, and the reminder vocabulary each one maps to in `ai_reminders`. */
export const PAYMENT_KIND = Object.freeze({ COLLECT: "collect", PAY: "pay" });

export const PAYMENT_REMINDER_TYPE = Object.freeze({
  [PAYMENT_KIND.COLLECT]: "COLLECT_PAYMENT",
  [PAYMENT_KIND.PAY]: "PAY_SUPPLIER",
});

const LINKED_ENTITY_TYPE = Object.freeze({
  [PAYMENT_KIND.COLLECT]: "customer",
  [PAYMENT_KIND.PAY]: "supplier",
});

/** Where the popup remembers, per local day, that it was closed and which rows were dealt with. */
export const PAYMENTS_DUE_MEMORY_STORAGE_KEY = "froozerp_payments_due_popup";

/** The bell rows' source label, and the key the "could not be read" row always occupies. */
export const PAYMENTS_BELL_SOURCE = "Payments";
export const PAYMENTS_UNREADABLE_KEY = "payment:unreadable";

const DATE_KEY = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const text = (value) => (typeof value === "string" ? value.trim() : "");

/** Is this a real calendar day in YYYY-MM-DD form? "2026-02-30" is not. */
export const isDateKey = (value) => {
  const match = DATE_KEY.exec(typeof value === "string" ? value : "");
  if (!match) return false;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const probe = new Date(Date.UTC(year, month - 1, day));
  return probe.getUTCFullYear() === year && probe.getUTCMonth() === month - 1 && probe.getUTCDate() === day;
};

/**
 * The device's local calendar day as YYYY-MM-DD.
 *
 * Never `toISOString().slice(0, 10)`: that is the UTC day, which in IST is yesterday until 05:30.
 * Returns "" for anything that is not a readable date, rather than guessing a day.
 */
export const localDateKey = (date) => {
  if (!(date instanceof Date)) return "";
  const time = date.getTime();
  if (!Number.isFinite(time)) return "";
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

/**
 * A day key moved by whole days. Calendar arithmetic on the key itself, in UTC, so a DST shift or
 * the device's zone cannot move the answer. "" when the key is not a real day.
 */
export const shiftDateKey = (dateKey, days) => {
  if (!isDateKey(dateKey) || !Number.isInteger(days)) return "";
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return `${String(moved.getUTCFullYear()).padStart(4, "0")}-${String(moved.getUTCMonth() + 1).padStart(2, "0")}-${String(moved.getUTCDate()).padStart(2, "0")}`;
};

/** Whole days from one key to the other; `null` when either is not a real day. */
const daysBetween = (fromKey, toKey) => {
  if (!isDateKey(fromKey) || !isDateKey(toKey)) return null;
  const toUtc = (key) => {
    const [year, month, day] = key.split("-").map((part) => Number(part));
    return Date.UTC(year, month - 1, day);
  };
  return Math.round((toUtc(toKey) - toUtc(fromKey)) / 86400000);
};

/** The first ten characters of a stored date, when they are a real day — the server's own day. */
const dayOf = (value) => {
  const key = typeof value === "string" ? value.slice(0, 10) : "";
  return isDateKey(key) ? key : "";
};

/** "10 Sep", or "10 Sep 2025" when the year is not the reference day's year. */
export const describeDay = (dateKey, referenceKey = "") => {
  if (!isDateKey(dateKey)) return "";
  const [year, month, day] = dateKey.split("-");
  const short = `${Number(day)} ${MONTHS[Number(month) - 1]}`;
  return isDateKey(referenceKey) && referenceKey.slice(0, 4) === year ? short : `${short} ${year}`;
};

const rupees = (fractionDigits) => new Intl.NumberFormat("en-IN", {
  style: "currency",
  currency: "INR",
  minimumFractionDigits: fractionDigits,
  maximumFractionDigits: fractionDigits,
});
const WHOLE_RUPEES = rupees(0);
const RUPEES_AND_PAISE = rupees(2);

/**
 * Money the way the owner says it: "₹12,000", "₹1,20,000", "₹12,000.50".
 *
 * Rounded to 2dp like the rest of the app. Whole rupees drop the ".00" because that is how a
 * sentence reads; anything with paise keeps both digits, so "₹12,000.5" never appears. Returns ""
 * for a value that is not a finite number — the caller then says the amount could not be read,
 * never "₹0".
 */
export const formatRupees = (value) => {
  const amount = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN);
  if (!Number.isFinite(amount)) return "";
  const rounded = Math.round(amount * 100) / 100;
  const whole = Math.abs(rounded - Math.round(rounded)) < 0.0000001;
  return (whole ? WHOLE_RUPEES : RUPEES_AND_PAISE).format(whole ? Math.round(rounded) : rounded);
};

const amountOf = (value) => {
  const amount = typeof value === "number" ? value : (typeof value === "string" && value.trim() !== "" ? Number(value) : Number.NaN);
  return Number.isFinite(amount) ? Math.round(amount * 100) / 100 : null;
};

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "(due today)", "(due 10 Sep, 13 days late)" — the timing half of a row. */
const describeTiming = (dueKey, overdueDays, dateKey) => {
  if (!dueKey) return "no due date could be read";
  if (overdueDays === 0) return "due today";
  if (overdueDays > 0) return `due ${describeDay(dueKey, dateKey)}, ${plural(overdueDays, "day")} late`;
  return `due ${describeDay(dueKey, dateKey)}`;
};

const overdueFor = (row, dueKey, dateKey) => {
  const sent = row?.overdue_days;
  if (typeof sent === "number" && Number.isInteger(sent) && sent >= 0) return sent;
  const gap = daysBetween(dueKey, dateKey);
  return gap === null ? null : gap;
};

/**
 * One server row as the popup and the bell read it, or `null` for something unusable.
 *
 * `settled: true` (a reminder whose balance is now zero) is not shown, and neither is a row whose
 * amount reads as zero or less: the contract says those are the same thing, and asking the owner to
 * collect ₹0 would be the one wrong sentence the popup could say.
 */
const toRow = (row, kind, dateKey) => {
  if (!row || typeof row !== "object") return null;
  if (row.settled === true) return null;
  const isCollect = kind === PAYMENT_KIND.COLLECT;
  const entityId = canonicalInventoryId(isCollect ? row.customer_id : row.supplier_id);
  const key = text(row.key) || (entityId ? `${LINKED_ENTITY_TYPE[kind]}:${entityId}` : "");
  if (!key) return null;
  const amount = amountOf(row.outstanding_amount);
  if (amount !== null && amount <= 0) return null;
  const entityName = text(isCollect ? row.customer_name : row.supplier_name)
    || (isCollect ? "a customer with no name on file" : "a supplier with no name on file");
  const dueDate = dayOf(row.due_date);
  const overdueDays = dueDate ? overdueFor(row, dueDate, dateKey) : null;
  const amountText = formatRupees(amount);
  const timing = describeTiming(dueDate, overdueDays, dateKey);
  // An amount that did not survive the trip is said as such. It is still a row: a customer who owes
  // does not vanish from the list because one field was unreadable.
  const lineText = isCollect
    ? (amountText ? `Collect ${amountText} from ${entityName} (${timing})` : `Collect from ${entityName} -- the amount could not be read (${timing})`)
    : (amountText ? `Pay ${entityName} ${amountText} (${timing})` : `Pay ${entityName} -- the amount could not be read (${timing})`);
  const reminderId = canonicalInventoryId(row.reminder_id);
  return {
    key,
    kind,
    entityId,
    entityName,
    amount,
    amountText,
    dueDate,
    overdueDays,
    source: text(row.source).toUpperCase() || "BILL",
    reminderId: reminderId || null,
    timing,
    text: lineText,
  };
};

const rowsOf = (list, kind, dateKey, hidden) => {
  const rows = [];
  const seen = new Set();
  for (const raw of list) {
    const row = toRow(raw, kind, dateKey);
    if (!row || seen.has(row.key) || hidden.has(row.key)) continue;
    seen.add(row.key);
    rows.push(row);
  }
  return rows;
};

/**
 * Read what the payments list says, or say why it could not be read.
 *
 * Shared by the popup, the bell and the panel so the three can never disagree about whether the
 * list was read — the summary-versus-detail pitfall in CLAUDE.md.
 */
const readPayload = ({ payload, failure, dateKey }) => {
  const failureMessage = text(failure);
  if (failureMessage) {
    return { ok: false, message: `Today's payments could not be read, so this is not an empty list -- it is no list. ${failureMessage}` };
  }
  if (!isDateKey(dateKey)) {
    return { ok: false, message: "The app could not read today's date, so it cannot tell which payments are due. Close and reopen FroozERP." };
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.collect) || !Array.isArray(payload.pay)) {
    return { ok: false, message: "The payments list arrived in a shape this app could not read, so it cannot say who to collect from or pay today." };
  }
  // A list for another day is not today's list. It happens across midnight, between the day
  // changing and the next refresh; showing yesterday's rows as today's would be a wrong answer.
  if (payload.date !== undefined && payload.date !== null && text(payload.date) !== dateKey) {
    return { ok: false, message: `The payments list on screen is for ${describeDay(text(payload.date), dateKey) || "another day"}, not today. It will refresh shortly.` };
  }
  return { ok: true, message: "" };
};

/**
 * The "Today's payments" popup.
 *
 * @param {object} input
 * @param {object} input.payload           the body of `GET /api/ai/payments-due`
 * @param {string} [input.failure]         the load error, when the request failed
 * @param {string} input.dateKey           today's LOCAL day, from {@link localDateKey}
 * @param {string} [input.dismissedDateKey] the day the popup was last closed
 * @param {Array<string>} [input.hiddenKeys] row keys already dealt with today on this device
 * @returns {{status: string, show: boolean, collectRows: Array<object>, payRows: Array<object>,
 *            message: string, collectTotal: number, payTotal: number}}
 */
export const buildPaymentsDuePopup = ({ payload, failure = "", dateKey, dismissedDateKey = "", hiddenKeys = [] } = {}) => {
  const unreadable = (message) => ({
    status: PAYMENTS_DUE_STATUS.UNREADABLE,
    show: false,
    collectRows: [],
    payRows: [],
    message,
    collectTotal: 0,
    payTotal: 0,
  });
  try {
    const read = readPayload({ payload, failure, dateKey });
    if (!read.ok) return unreadable(read.message);
    const hidden = new Set(Array.isArray(hiddenKeys) ? hiddenKeys.map((key) => text(key)).filter(Boolean) : []);
    const collectRows = rowsOf(payload.collect, PAYMENT_KIND.COLLECT, dateKey, hidden);
    const payRows = rowsOf(payload.pay, PAYMENT_KIND.PAY, dateKey, hidden);
    const total = (rows) => Math.round(rows.reduce((sum, row) => sum + (row.amount ?? 0), 0) * 100) / 100;
    const count = collectRows.length + payRows.length;
    const parts = [];
    if (collectRows.length) parts.push(`collect from ${plural(collectRows.length, "customer")}`);
    if (payRows.length) parts.push(`pay ${plural(payRows.length, "supplier")}`);
    const message = count
      ? `Today: ${parts.join(" and ")}.`
      : "Nothing to collect or pay today.";
    return {
      status: PAYMENTS_DUE_STATUS.OK,
      show: count > 0 && text(dismissedDateKey) !== dateKey,
      collectRows,
      payRows,
      message,
      collectTotal: total(collectRows),
      payTotal: total(payRows),
    };
  } catch {
    return unreadable("Today's payments could not be read. Reopen FroozERP if this stays.");
  }
};

/**
 * What the popup remembers for today, read from its stored string.
 *
 * Anything unreadable — no value, bad JSON, another day's memory — reads as "nothing remembered",
 * which means the popup opens again. That is the safe direction: a popup shown twice is a nuisance;
 * a popup silently suppressed hides money.
 */
export const readPaymentsDueMemory = (raw, dateKey) => {
  try {
    const stored = typeof raw === "string" && raw ? JSON.parse(raw) : null;
    if (!stored || typeof stored !== "object" || !isDateKey(dateKey) || stored.date !== dateKey) {
      return { date: isDateKey(dateKey) ? dateKey : "", dismissed: false, hiddenKeys: [] };
    }
    return {
      date: dateKey,
      dismissed: stored.dismissed === true,
      hiddenKeys: Array.isArray(stored.hiddenKeys) ? stored.hiddenKeys.map((key) => text(key)).filter(Boolean) : [],
    };
  } catch {
    return { date: isDateKey(dateKey) ? dateKey : "", dismissed: false, hiddenKeys: [] };
  }
};

/** The memory after closing the popup and/or putting one row away for today. */
export const nextPaymentsDueMemory = (memory, dateKey, { dismiss = false, hideKey = "" } = {}) => {
  const current = memory && memory.date === dateKey ? memory : { date: dateKey, dismissed: false, hiddenKeys: [] };
  const hiddenKeys = [...(current.hiddenKeys || [])];
  const key = text(hideKey);
  if (key && !hiddenKeys.includes(key)) hiddenKeys.push(key);
  return { date: dateKey, dismissed: current.dismissed === true || dismiss === true, hiddenKeys };
};

/**
 * The request that sets, moves or clears a payment reminder.
 *
 * - With an existing reminder and a date: `PATCH /api/ai/reminders/:id {action: "SET_DUE_DATE"}`.
 * - With an existing reminder and no date: `PATCH ... {action: "RESOLVE"}` — clearing the "ask on"
 *   date takes the reminder away rather than leaving an undated payment reminder that nothing reads.
 * - With no reminder: `POST /api/ai/reminders` creating one, linked to the account by its id as a
 *   string. `null` when there is no reminder and no date, because there is nothing to send.
 *
 * Throws on a kind it does not know, a missing account id, or a date that is not a real day: the
 * caller shows that as a failed save rather than creating a reminder on the wrong account or day.
 */
export const paymentReminderRequest = ({ kind, entityId, entityName = "", amount, dueDate = "", existingReminderId = null } = {}) => {
  const reminderType = PAYMENT_REMINDER_TYPE[kind];
  if (!reminderType) throw new Error("A payment reminder must be either collect or pay.");
  const day = text(dueDate);
  if (day && !isDateKey(day)) throw new Error("That date could not be read.");
  const existing = canonicalInventoryId(existingReminderId);
  if (existing) {
    const path = `/api/ai/reminders/${encodeURIComponent(existing)}`;
    return day
      ? { method: "PATCH", path, body: { action: "SET_DUE_DATE", due_at: day } }
      : { method: "PATCH", path, body: { action: "RESOLVE" } };
  }
  if (!day) return null;
  const id = canonicalInventoryId(entityId);
  if (!id) throw new Error("This account has no id, so a reminder cannot be linked to it.");
  const name = text(entityName) || (kind === PAYMENT_KIND.COLLECT ? "this customer" : "this supplier");
  const amountText = formatRupees(amount);
  const isCollect = kind === PAYMENT_KIND.COLLECT;
  return {
    method: "POST",
    path: "/api/ai/reminders",
    body: {
      reminder_type: reminderType,
      priority: "ATTENTION",
      linked_entity_type: LINKED_ENTITY_TYPE[kind],
      linked_entity_id: id,
      due_at: day,
      title: isCollect ? `Collect payment from ${name}` : `Pay ${name}`,
      message: isCollect
        ? (amountText ? `Collect ${amountText} from ${name}.` : `Collect the outstanding balance from ${name}.`)
        : (amountText ? `Pay ${name} ${amountText}.` : `Pay the outstanding balance to ${name}.`),
    },
  };
};

/**
 * The request behind "Done": resolve the reminder, when the row came from one. `null` for a row
 * that came from a bill alone -- there is nothing on the server to close, and the caller only puts
 * the row away for today on this device.
 */
export const resolvePaymentReminderRequest = (reminderId) => {
  const id = canonicalInventoryId(reminderId);
  return id ? { method: "PATCH", path: `/api/ai/reminders/${encodeURIComponent(id)}`, body: { action: "RESOLVE" } } : null;
};

/** Is this `ai_reminders` row a payment reminder? Those ring through the payments bell rows. */
export const isPaymentReminder = (row) => {
  const type = text(row?.reminder_type ?? row?.reminderType).toUpperCase();
  return type === PAYMENT_REMINDER_TYPE[PAYMENT_KIND.COLLECT] || type === PAYMENT_REMINDER_TYPE[PAYMENT_KIND.PAY];
};

/**
 * The fields a FROST `reminder_draft` passes to `POST /api/ai/reminders`.
 *
 * The backend adds `reminder_type`, `linked_entity_type` and `linked_entity_id` when the reminder
 * names exactly one known customer or supplier. They are passed through only as a consistent set —
 * a collect reminder linked to a customer, or a pay reminder linked to a supplier, with an id — and
 * anything else stays an `OWNER_NOTE`, so a half-filled draft cannot create a payment reminder
 * pointing at nobody.
 */
export const reminderDraftLinkFields = (draft) => {
  const type = text(draft?.reminder_type).toUpperCase();
  const entityType = text(draft?.linked_entity_type).toLowerCase();
  const entityId = canonicalInventoryId(draft?.linked_entity_id);
  const kind = type === PAYMENT_REMINDER_TYPE[PAYMENT_KIND.COLLECT]
    ? PAYMENT_KIND.COLLECT
    : type === PAYMENT_REMINDER_TYPE[PAYMENT_KIND.PAY] ? PAYMENT_KIND.PAY : "";
  if (!kind || entityType !== LINKED_ENTITY_TYPE[kind] || !entityId) return { reminder_type: "OWNER_NOTE" };
  return { reminder_type: type, linked_entity_type: entityType, linked_entity_id: entityId };
};

/**
 * Today's payments as bell rows, in the shape the FROST bell publisher consumes: `{status, items,
 * keys, message}`, each item ready for `createNotification`.
 *
 * Keys are `payment:<row.key>:<dateKey>`: stable across the day's polls, so a row is raised once;
 * and new each day, so a payment still owed tomorrow rings again tomorrow. On a failure the answer
 * is one sticky error row and `status: unreadable` — the caller must not retract anything then.
 *
 * @param {object} payload the body of `GET /api/ai/payments-due`
 * @param {string} dateKey today's LOCAL day
 * @param {object} [options]
 * @param {string} [options.failure] the load error, when the request failed
 * @param {number} [options.nowMs]   stamps the rows; omitted, `createNotification` stamps them
 */
export const paymentsDueBellItems = (payload, dateKey, { failure = "", nowMs } = {}) => {
  const at = typeof nowMs === "number" && Number.isFinite(nowMs) ? new Date(nowMs).toISOString() : undefined;
  const popup = buildPaymentsDuePopup({ payload, failure, dateKey });
  if (popup.status !== PAYMENTS_DUE_STATUS.OK) {
    return {
      status: PAYMENTS_DUE_STATUS.UNREADABLE,
      message: popup.message,
      keys: [PAYMENTS_UNREADABLE_KEY],
      items: [{
        id: PAYMENTS_UNREADABLE_KEY,
        dedupeKey: PAYMENTS_UNREADABLE_KEY,
        severity: NOTIFICATION_SEVERITY.ERROR,
        title: "Today's payments could not be read",
        message: popup.message,
        source: PAYMENTS_BELL_SOURCE,
        at,
        // Still true until a read succeeds; clearing the bell must not hide that nobody is watching.
        sticky: true,
      }],
    };
  }
  const items = [...popup.collectRows, ...popup.payRows].map((row) => {
    const key = `payment:${row.key}:${dateKey}`;
    return {
      id: key,
      dedupeKey: key,
      severity: NOTIFICATION_SEVERITY.WARNING,
      // The whole sentence, amount included, is the message: the publisher re-raises a row only
      // when its message changes, so a changed amount must change the message.
      title: row.kind === PAYMENT_KIND.COLLECT ? `Collect from ${row.entityName}` : `Pay ${row.entityName}`,
      message: `${row.text}.`,
      source: PAYMENTS_BELL_SOURCE,
      at,
      sticky: false,
    };
  });
  return { status: PAYMENTS_DUE_STATUS.OK, message: "", keys: items.map((item) => item.dedupeKey), items };
};

/**
 * The "Prepare WhatsApp" link for each collect row, joined from the dues outreach rows.
 *
 * Only a row whose outreach action is SEND gets a link — a customer who opted out, has no number,
 * or a user who may not send gets none. Joined on the canonical id, never on a coerced number.
 *
 * @param {Array<object>} collectRows rows from {@link buildPaymentsDuePopup}
 * @param {object|null} outreach      the result of `buildDueOutreachRows`
 * @param {string} sendAction         `DUE_OUTREACH_ACTION.SEND`, passed in to keep this module
 *                                    free of a second copy of that vocabulary
 */
export const attachWhatsappLinks = (collectRows, outreach, sendAction = "SEND") => {
  const byId = new Map();
  if (outreach && outreach.status === "ok" && Array.isArray(outreach.rows)) {
    for (const row of outreach.rows) {
      const id = canonicalInventoryId(row?.customer_id);
      if (id && row.action === sendAction && text(row.link) && !byId.has(id)) byId.set(id, row.link);
    }
  }
  return (Array.isArray(collectRows) ? collectRows : []).map((row) => ({
    ...row,
    whatsappLink: row.kind === PAYMENT_KIND.COLLECT ? (byId.get(canonicalInventoryId(row.entityId)) || "") : "",
  }));
};

/**
 * The "ask for payment on" / "pay on" dates for the dues panel.
 *
 * `customersById` maps a canonical customer id to its current reminder, so the panel can show the
 * date beside each customer. `suppliers` is the "You owe suppliers" list. On a failure the status
 * says so and the panel shows why, rather than empty date boxes that would read as "no date set" —
 * and would create a duplicate reminder if he typed one in.
 */
export const buildPaymentPlan = ({ payload, failure = "" } = {}) => {
  const unreadable = (message) => ({ status: PAYMENTS_DUE_STATUS.UNREADABLE, message, customersById: new Map(), suppliers: [] });
  try {
    const failureMessage = text(failure);
    if (failureMessage) return unreadable(`Payment dates could not be read. ${failureMessage}`);
    if (!payload || typeof payload !== "object" || !Array.isArray(payload.customers) || !Array.isArray(payload.suppliers)) {
      return unreadable("Payment dates arrived in a shape this app could not read.");
    }
    const reminderOf = (entry) => {
      const reminder = entry?.payment_reminder;
      const id = canonicalInventoryId(reminder?.id);
      return id ? { id, dueAt: dayOf(reminder.due_at) } : null;
    };
    const customersById = new Map();
    for (const entry of payload.customers) {
      const id = canonicalInventoryId(entry?.customer_id);
      if (!id || customersById.has(id)) continue;
      customersById.set(id, {
        customerId: id,
        name: text(entry.customer_name),
        amount: amountOf(entry.outstanding_amount),
        nextDueDate: dayOf(entry.next_due_date),
        reminder: reminderOf(entry),
      });
    }
    const suppliers = [];
    const seen = new Set();
    for (const entry of payload.suppliers) {
      const id = canonicalInventoryId(entry?.supplier_id);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const amount = amountOf(entry.outstanding_amount);
      suppliers.push({
        key: `supplier:${id}`,
        supplierId: id,
        name: text(entry.supplier_name) || "A supplier with no name on file",
        amount,
        amountText: formatRupees(amount) || "Amount could not be read",
        oldestPurchaseDate: dayOf(entry.oldest_purchase_date),
        reminder: reminderOf(entry),
      });
    }
    return { status: PAYMENTS_DUE_STATUS.OK, message: "", customersById, suppliers };
  } catch {
    return unreadable("Payment dates could not be read.");
  }
};
