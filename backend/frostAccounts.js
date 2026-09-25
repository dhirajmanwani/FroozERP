"use strict";

/**
 * FROST, per account: who owes what, since when, and who is due today.
 *
 * Dhiraj asked "konse customer ka paisa sabse zyada due hai" and FROST answered with the shop's
 * total dues and three names, because every answer it could give was built from a whole-ledger
 * fact. He also asked to be told, on the day, "aaj ABC se payment maangna hai" and "aaj XYZ ko
 * payment dena hai". Both need the same thing the books never offered FROST before: one row per
 * account, with the day its money fell due.
 *
 * Everything here is pure. The service reads rows and hands them in; nothing in this file touches
 * a database, a clock or the network. That is what makes the FIFO rule, the date arithmetic and the
 * wording testable without a Postgres, and it keeps the one rule that matters most -- every figure
 * in an answer comes out of the books -- checkable by `assertGroundedAnswer` in a unit test.
 *
 * ## Ids
 *
 * Entity ids are opaque strings. "004" and 4 are two different customers, so every map below is
 * keyed by `String(id).trim()` and nothing is ever passed through `Number()`. A mismatch here would
 * not empty a table; it would attach one customer's payments to another customer's bills.
 *
 * ## Days
 *
 * A day is a `YYYY-MM-DD` string throughout. `pg` hands a DATE back either as that string (the
 * storage adapter pins the parser) or as a `Date` at *local* midnight (the default parser), and a
 * reminder's `due_at` arrives already converted by `reminderDueAtWallClock`. Reading a `Date` with
 * `toISOString()` would move every date one day back on a laptop in India, so `dayKey` reads its
 * local parts -- the same rule `reminderDueAtWallClock` follows -- and all arithmetic afterwards is
 * on UTC day numbers, which have no time zone to disagree about.
 */

const { money } = require("./frostAnswer");

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The one key an id is compared by. Never `Number()`: "004" and 4 are different entities. */
const idKey = (value) => (value === null || value === undefined ? "" : String(value).trim());

const round2 = (value) => {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.round((number + Number.EPSILON) * 100) / 100;
};

// Money is compared in paise. Summing rupee floats bill by bill is how ₹0.01 of rounding leaves a
// fully-paid bill looking "not fully covered", and FIFO would then report a due date for a
// customer who owes nothing on it.
const toPaise = (value) => {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) : 0;
};
const fromPaise = (paise) => round2(paise / 100);

const isRealDay = (text) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(text || ""));
  if (!match) return false;
  const [, year, month, day] = match;
  const parsed = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  // The rollover check: "2026-02-31" constructs happily as 3 March.
  return parsed.getUTCFullYear() === Number(year)
    && parsed.getUTCMonth() + 1 === Number(month)
    && parsed.getUTCDate() === Number(day);
};

/** A stored date or timestamp as the calendar day it names, or null. See "Days" above. */
const dayKey = (value) => {
  if (value === null || value === undefined || value === "") return null;
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const pad = (part) => String(part).padStart(2, "0");
    return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}`;
  }
  const head = String(value).trim().slice(0, 10);
  return isRealDay(head) ? head : null;
};

const dayNumber = (day) => {
  const [year, month, date] = day.split("-").map((part) => Number.parseInt(part, 10));
  return Date.UTC(year, month - 1, date) / MS_PER_DAY;
};

/** Whole days from `from` to `to`; positive when `to` is later. */
const daysBetween = (from, to) => dayNumber(to) - dayNumber(from);

/** "2026-09-10" -> "10 Sep". The way the counter writes a date, and what the owner reads fastest. */
const shortDay = (day) => {
  if (!day || !isRealDay(day)) return "";
  const [, month, date] = day.split("-");
  return `${Number.parseInt(date, 10)} ${MONTHS[Number.parseInt(month, 10) - 1]}`;
};

/**
 * The `date` the payments-due route answers for, or null when it must be refused.
 *
 * The caller sends its own calendar day because the laptop is in India and the server may not be:
 * between midnight and 05:30 IST the server's day is still yesterday, and "aaj" would mean the
 * wrong day for five and a half hours. It is still bounded to two days either side of the server's
 * day, so a wrong clock or a typo cannot silently ask about next month.
 */
const PAYMENTS_DUE_DATE_WINDOW_DAYS = 2;

const resolvePaymentsDueDate = (value, serverDay) => {
  if (!isRealDay(serverDay)) return null;
  if (value === undefined || value === null || value === "") return serverDay;
  // `?date=a&date=b` arrives as an array. Picking one would be a guess about which the caller meant.
  if (typeof value !== "string") return null;
  const day = value.trim();
  if (!isRealDay(day)) return null;
  return Math.abs(daysBetween(serverDay, day)) <= PAYMENTS_DUE_DATE_WINDOW_DAYS ? day : null;
};

/* ------------------------------------------------------------------------------ the ledger */

/**
 * Which of each customer's credit bills is the first one not yet paid off, and when it was due.
 *
 * FIFO, because that is how the shop and the customer both count it: a payment settles the oldest
 * bill first. Payments and credit-note returns are pooled per customer and applied to the bills in
 * `sale_date` order (the query orders by `sale_date, id`, and a stable sort here keeps that order
 * for bills of the same day). The first bill the pool does not fully cover is where the unpaid
 * money starts.
 *
 * A bill with no due date contributes no date. It is still paid off in its turn -- skipping it in
 * the FIFO would move a payment onto a later bill it was never made against -- but when it is the
 * first uncovered bill, the next uncovered bill that *does* carry a due date gives the date. An
 * undated walk-up bill must not hide the overdue dated one behind it. When no uncovered bill carries
 * a date, `next_due_date` is null: a customer who was given no due date is not overdue.
 *
 * Returns a Map keyed by `idKey(customer_id)`.
 */
const nextUnpaidDueDates = ({ bills = [], credits = [] } = {}) => {
  const creditBy = new Map();
  for (const row of Array.isArray(credits) ? credits : []) {
    if (!row) continue;
    const key = idKey(row.customer_id);
    creditBy.set(key, (creditBy.get(key) || 0) + toPaise(row.paid_amount) + toPaise(row.returned_amount));
  }
  const billsBy = new Map();
  for (const bill of Array.isArray(bills) ? bills : []) {
    if (!bill) continue;
    const key = idKey(bill.customer_id);
    if (!billsBy.has(key)) billsBy.set(key, []);
    billsBy.get(key).push(bill);
  }
  const result = new Map();
  for (const [key, list] of billsBy) {
    // An undated bill sorts last rather than first: "" would put it ahead of every real day.
    const ordered = list
      .map((bill, index) => ({ bill, index, day: dayKey(bill.sale_date) || "9999-12-31" }))
      .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.index - b.index))
      .map(({ bill }) => bill);
    let pool = creditBy.get(key) || 0;
    let billed = 0;
    let unpaidSince = null;
    let unpaidBillId = null;
    let nextDueDate = null;
    let nextDueBillId = null;
    for (const bill of ordered) {
      const amount = toPaise(bill.total_amount);
      billed += amount;
      if (pool >= amount) {
        pool -= amount;
        continue;
      }
      pool = 0;
      if (unpaidBillId === null) {
        unpaidSince = dayKey(bill.sale_date);
        unpaidBillId = bill.id ?? null;
      }
      const due = dayKey(bill.due_date);
      if (due && nextDueDate === null) {
        nextDueDate = due;
        nextDueBillId = bill.id ?? null;
      }
    }
    const credited = creditBy.get(key) || 0;
    result.set(key, {
      customer_id: list[0].customer_id ?? null,
      billed_amount: fromPaise(billed),
      credited_amount: fromPaise(credited),
      outstanding_amount: fromPaise(Math.max(0, billed - credited)),
      next_due_date: nextDueDate,
      next_due_bill_id: nextDueBillId,
      unpaid_since: unpaidSince,
      unpaid_bill_id: unpaidBillId,
    });
  }
  return result;
};

/**
 * One row per customer with any credit history at this branch, owing or not.
 *
 * Zero balances are kept on purpose. "Ramesh ka kitna baaki hai" about a customer who has paid up
 * is answered "Ramesh owes you nothing now", which is different from "I could not find Ramesh" --
 * and a reminder that fell due for a customer who has since paid is shown as settled, not dropped.
 *
 * `customers` carries the per-customer credit side (payments, credit-note returns, last payment);
 * `customerBills` the bills. Either may name a customer the other does not.
 */
const buildCustomerLedger = ({ customers = [], customerBills = [] } = {}) => {
  const fifo = nextUnpaidDueDates({ bills: customerBills, credits: customers });
  const rows = new Map();
  const names = new Map();
  for (const bill of Array.isArray(customerBills) ? customerBills : []) {
    const key = idKey(bill?.customer_id);
    if (bill?.customer_name && !names.has(key)) names.set(key, String(bill.customer_name));
  }
  const lastPayment = new Map();
  for (const row of Array.isArray(customers) ? customers : []) {
    if (!row) continue;
    const key = idKey(row.customer_id);
    if (row.customer_name && !names.has(key)) names.set(key, String(row.customer_name));
    const paid = dayKey(row.last_payment_date);
    if (paid && (!lastPayment.has(key) || paid > lastPayment.get(key))) lastPayment.set(key, paid);
    if (!fifo.has(key) && !rows.has(key)) {
      rows.set(key, {
        customer_id: row.customer_id ?? null,
        billed_amount: 0,
        credited_amount: fromPaise(toPaise(row.paid_amount) + toPaise(row.returned_amount)),
        outstanding_amount: 0,
        next_due_date: null,
        next_due_bill_id: null,
        unpaid_since: null,
        unpaid_bill_id: null,
      });
    }
  }
  for (const [key, row] of fifo) rows.set(key, row);
  return [...rows.entries()].map(([key, row]) => ({
    key: `customer:${key}`,
    ...row,
    customer_name: names.get(key) || "Walk-in Customer",
    last_payment_date: lastPayment.get(key) || null,
  }));
};

/**
 * One row per supplier. The purchases query groups by id *and* name, so a supplier whose bills
 * carry two spellings arrives as two rows; they are one account and are summed here by id.
 */
const buildSupplierLedger = (suppliers = []) => {
  const rows = new Map();
  for (const row of Array.isArray(suppliers) ? suppliers : []) {
    if (!row) continue;
    const key = idKey(row.supplier_id);
    const oldest = dayKey(row.oldest_purchase_date);
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, {
        key: `supplier:${key}`,
        supplier_id: row.supplier_id ?? null,
        supplier_name: String(row.supplier_name || "Supplier"),
        outstanding_paise: toPaise(row.outstanding_amount),
        oldest_purchase_date: oldest,
      });
      continue;
    }
    existing.outstanding_paise += toPaise(row.outstanding_amount);
    if (oldest && (!existing.oldest_purchase_date || oldest < existing.oldest_purchase_date)) existing.oldest_purchase_date = oldest;
  }
  return [...rows.values()].map(({ outstanding_paise: paise, ...row }) => ({
    ...row,
    outstanding_amount: fromPaise(Math.max(0, paise)),
  }));
};

/* ------------------------------------------------------------------------- payments due */

const REMINDER_KINDS = Object.freeze({
  customer: { reminderType: "COLLECT_PAYMENT", entityType: "customer" },
  supplier: { reminderType: "PAY_SUPPLIER", entityType: "supplier" },
});

/**
 * Open payment reminders of one kind, earliest first, grouped by the account they name.
 *
 * A reminder with no day is left out. It cannot fall due, and the contract's `payment_reminder`
 * carries a day; an undated one is still in the Reminders list, where it can be dated.
 */
const remindersByAccount = (reminders, kind) => {
  const { reminderType, entityType } = REMINDER_KINDS[kind];
  const grouped = new Map();
  const list = (Array.isArray(reminders) ? reminders : [])
    .map((row, index) => ({ row, index, day: dayKey(row?.due_at) }))
    .filter(({ row, day }) => row
      && day
      && String(row.reminder_type || "").toUpperCase() === reminderType
      && String(row.linked_entity_type || "").toLowerCase() === entityType
      && idKey(row.linked_entity_id) !== "")
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : a.index - b.index));
  for (const entry of list) {
    const key = idKey(entry.row.linked_entity_id);
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(entry);
  }
  return grouped;
};

// Most overdue first, then the larger amount, then by name so two equal rows keep one order.
const byUrgency = (a, b) => (b.overdue_days - a.overdue_days)
  || (b.outstanding_amount - a.outstanding_amount)
  || String(a.customer_name || a.supplier_name || "").localeCompare(String(b.customer_name || b.supplier_name || ""))
  || a.key.localeCompare(b.key);

const byAmount = (nameField) => (a, b) => (b.outstanding_amount - a.outstanding_amount)
  || String(a[nameField]).localeCompare(String(b[nameField]))
  || a.key.localeCompare(b.key);

/**
 * The `GET /api/ai/payments-due` payload.
 *
 * `collect`: every customer who owes money and whose next unpaid bill (FIFO) was due on or before
 * `date`, plus every customer with an open COLLECT_PAYMENT reminder due on or before `date` -- one
 * row per customer, and a reminder wins `source`, because it is the day the owner chose himself.
 * `pay`: suppliers carry no due date in the books, so only his PAY_SUPPLIER reminders put one here.
 *
 * A reminder that is due for an account that now owes nothing is kept, as `settled: true`. Dropping
 * it would leave the reminder open in the list with no way to see from the popup why it did not
 * show; saying "settled" lets him close it.
 *
 * A reminder that is snoozed right now (`currently_snoozed`, worked out by the query against the
 * database clock) is not due: the snooze is his instruction to stop showing it until later.
 */
const buildPaymentsDue = ({ date, customers = [], customerBills = [], suppliers = [], reminders = [] } = {}) => {
  if (!isRealDay(date)) throw new Error("FROST_PAYMENTS_DATE_REQUIRED: buildPaymentsDue needs the day it answers for");
  const ledger = buildCustomerLedger({ customers, customerBills });
  const supplierLedger = buildSupplierLedger(suppliers);
  const customerBy = new Map(ledger.map((row) => [idKey(row.customer_id), row]));
  const supplierBy = new Map(supplierLedger.map((row) => [idKey(row.supplier_id), row]));
  const customerReminders = remindersByAccount(reminders, "customer");
  const supplierReminders = remindersByAccount(reminders, "supplier");
  const dueReminder = (entries = []) => entries.find(({ row, day }) => day <= date && row.currently_snoozed !== true) || null;
  const firstReminder = (entries = []) => (entries[0] ? { id: entries[0].row.id ?? null, due_at: entries[0].day } : null);
  const reminderName = (row, fallback) => String(row.linked_entity_name || fallback);

  const collect = new Map();
  for (const row of ledger) {
    if (row.outstanding_amount <= 0 || !row.next_due_date || row.next_due_date > date) continue;
    collect.set(idKey(row.customer_id), {
      key: row.key,
      customer_id: row.customer_id,
      customer_name: row.customer_name,
      outstanding_amount: row.outstanding_amount,
      due_date: row.next_due_date,
      overdue_days: Math.max(0, daysBetween(row.next_due_date, date)),
      source: "BILL",
      reminder_id: null,
      settled: false,
    });
  }
  for (const [key, entries] of customerReminders) {
    const due = dueReminder(entries);
    if (!due) continue;
    const account = customerBy.get(key);
    const outstanding = account ? account.outstanding_amount : 0;
    collect.set(key, {
      key: `customer:${key}`,
      customer_id: account ? account.customer_id : due.row.linked_entity_id,
      customer_name: account ? account.customer_name : reminderName(due.row, "Customer"),
      outstanding_amount: outstanding,
      due_date: due.day,
      overdue_days: Math.max(0, daysBetween(due.day, date)),
      source: "REMINDER",
      reminder_id: due.row.id ?? null,
      settled: outstanding <= 0,
    });
  }

  const pay = [];
  for (const [key, entries] of supplierReminders) {
    const due = dueReminder(entries);
    if (!due) continue;
    const account = supplierBy.get(key);
    const outstanding = account ? account.outstanding_amount : 0;
    pay.push({
      key: `supplier:${key}`,
      supplier_id: account ? account.supplier_id : due.row.linked_entity_id,
      supplier_name: account ? account.supplier_name : reminderName(due.row, "Supplier"),
      outstanding_amount: outstanding,
      due_date: due.day,
      overdue_days: Math.max(0, daysBetween(due.day, date)),
      source: "REMINDER",
      reminder_id: due.row.id ?? null,
      settled: outstanding <= 0,
    });
  }

  return {
    date,
    collect: [...collect.values()].sort(byUrgency),
    pay: pay.sort(byUrgency),
    customers: ledger
      .filter((row) => row.outstanding_amount > 0)
      .sort(byAmount("customer_name"))
      .map((row) => ({
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        outstanding_amount: row.outstanding_amount,
        next_due_date: row.next_due_date,
        payment_reminder: firstReminder(customerReminders.get(idKey(row.customer_id))),
      })),
    suppliers: supplierLedger
      .filter((row) => row.outstanding_amount > 0)
      .sort(byAmount("supplier_name"))
      .map((row) => ({
        supplier_id: row.supplier_id,
        supplier_name: row.supplier_name,
        outstanding_amount: row.outstanding_amount,
        oldest_purchase_date: row.oldest_purchase_date,
        payment_reminder: firstReminder(supplierReminders.get(idKey(row.supplier_id))),
      })),
    action_class: "READ_ONLY",
  };
};

/* ------------------------------------------------------------------------- the language */

// Each alternative is a whole word or a whole phrase, so a trailing `\b` can match every one of
// them. `\b(vasool)\b` against "vasooli" is fine because "vasooli" is written out too; the trap this
// codebase has fallen into twice is a *prefix* alternative with a boundary after it, which matches
// nothing. `frostAccounts.test.js` walks every alternative against its own pattern.
const TODAY_WORDS = /\b(aaj|aj|aaj\s*ka|today|todays|today's)\b/;
const RANKING_WORDS = /\b(most|sabse|zyada|zyaada|jyada|jyaada|jada|highest|biggest|largest|top)\b/;
const CUSTOMER_NOUNS = /\b(customer|customers|grahak|gaahak|gahak|graahak)\b/;
const SUPPLIER_NOUNS = /\b(supplier|suppliers|vyapari|vyaapari|arhatiya|arhati|arhat)\b/;
// Money coming in. "kisse" is "from whom"; "owes" in the third person can only be someone owing
// the shop, because the shop is never "he".
const COLLECT_WORDS = /\b(lena|leni|lene|maangna|maangni|maangne|maang|vasool|vasooli|vasuli|vasul|collect|collection|recover|recovery|receivable|kisse|kis\s+se|se\s+paisa|se\s+paise|se\s+payment|owes|owe\s+me|owe\s+us|owed\s+to\s+me|owed\s+to\s+us)\b/;
// Money going out. "dhyan dena" is "pay attention", not "pay" -- the same lookbehind
// `frostLanguage.js` needed for the briefing question "aaj kya dhyan dena hai".
const PAY_WORDS = /\b(chukana|chukani|chukane|bhugtan|payable|kisko|kise|kis\s+ko|ko\s+paisa|ko\s+paise|ko\s+payment|i\s+owe|we\s+owe|do\s+i\s+owe|i\s+have\s+to\s+pay|pay)\b|(?<!dhyan\s)\b(dena|deni|dene)\b/;

/**
 * Which side of the ledger a dues question is about.
 *
 * Nouns first: "customer" or "supplier" in the question settles it, whatever verb came with it --
 * "customer ne kitna dena hai" is a customer owing the shop, although "dena" on its own is paying.
 * Only a question naming neither is read by its verbs, and a question whose verbs point both ways
 * (or nowhere) is about both sides.
 *
 * "aaj"/"today" turns it into the day's list -- except in a ranking question, where "sabse zyada
 * aaj" still wants the ranking.
 */
const detectDuesFocus = (question = "") => {
  const text = String(question || "").toLowerCase();
  const customerNoun = CUSTOMER_NOUNS.test(text);
  const supplierNoun = SUPPLIER_NOUNS.test(text);
  let side = "both";
  if (customerNoun && !supplierNoun) side = "customer";
  else if (supplierNoun && !customerNoun) side = "supplier";
  else if (!customerNoun && !supplierNoun) {
    const collect = COLLECT_WORDS.test(text);
    const pay = PAY_WORDS.test(text);
    if (collect && !pay) side = "customer";
    else if (pay && !collect) side = "supplier";
  }
  if (TODAY_WORDS.test(text) && !RANKING_WORDS.test(text)) {
    if (side === "customer") return "today_collect";
    if (side === "supplier") return "today_pay";
    return "today_both";
  }
  return side;
};

// Words that are never a name, however a customer was entered. A customer saved as "Customer",
// "Cash" or "Walk-in Customer" is the counter's placeholder, not a person, and would otherwise
// match every question that says "customer".
const GENERIC_NAMES = new Set([
  "customer", "customers", "supplier", "suppliers", "walk in customer", "walk in", "walkin", "walkin customer",
  "cash", "cash customer", "cash sale", "general", "general customer", "party", "counter", "counter sale", "retail",
]);

// Words a name's single token is not matched on: trade words that sit inside many shop names, and
// the words of the dues questions themselves. A supplier called "Sharma Fruit Mandi" must not be
// found in "mandi ka kitna dena hai", and a customer called "Lena" must not be found in "abc se
// paisa lena hai".
const NAME_STOPWORDS = new Set([
  "the", "and", "for", "from", "with", "sons", "son", "bros", "brothers", "traders", "trader", "trading",
  "company", "enterprises", "enterprise", "agency", "agencies", "store", "stores", "mart", "shop",
  "fruit", "fruits", "fruit's", "vegetable", "vegetables", "sabzi", "mandi", "market", "wholesale",
  "retail", "ltd", "pvt", "private", "limited", "bhai", "ji", "kumar", "sahab", "saheb", "seth",
  "customer", "customers", "supplier", "suppliers", "party", "cash", "walk", "walkin", "general",
  "aaj", "today", "kal", "lena", "leni", "lene", "dena", "deni", "dene", "paisa", "paise", "payment",
  "payments", "baaki", "baki", "udhaar", "udhar", "hisab", "hisaab", "kitna", "kitni", "kitne",
  "hai", "hain", "karna", "maangna", "vasool", "due", "dues", "owe", "owes", "balance", "pay",
  "sabse", "zyada", "jyada", "most", "who", "which", "whom", "kis", "kisko", "kisse", "kiska",
  "remind", "reminder", "yaad", "dilana", "note", "mujhe", "mera", "meri", "mere",
]);

const normalizeWords = (text) => ` ${String(text || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()} `;

const nameOfAccount = (row = {}) => String(row.customer_name || row.supplier_name || row.name || "").trim();

/**
 * The accounts whose name the question says, as whole words.
 *
 * The full name wins: if "Ramesh Kumar" is in the question, "Ramesh Kumar" is the answer even when
 * a plain "Ramesh" also exists, and a name that is only part of a longer matched name is dropped.
 * Only when no full name matches is a single distinctive word of a name enough -- he says "Verma",
 * the books say "Verma Traders" -- and then every account carrying that word is returned, so two
 * Rameshes are both named rather than one chosen for him.
 */
const findNamedAccounts = (question = "", rows = []) => {
  const text = normalizeWords(question);
  const accounts = (Array.isArray(rows) ? rows : []).filter(Boolean).map((row) => {
    const normalized = normalizeWords(nameOfAccount(row)).trim();
    return { row, normalized };
  }).filter(({ normalized }) => normalized.replace(/\s+/g, "").length >= 3
    && !GENERIC_NAMES.has(normalized)
    && !NAME_STOPWORDS.has(normalized));

  const full = accounts.filter(({ normalized }) => text.includes(` ${normalized} `));
  if (full.length) {
    const kept = full.filter(({ normalized }) => !full.some((other) => other.normalized !== normalized
      && ` ${other.normalized} `.includes(` ${normalized} `)));
    return kept.map(({ row }) => row);
  }
  return accounts
    .filter(({ normalized }) => normalized.split(" ").some((token) => token.length >= 3
      && !/^\d+$/.test(token)
      && !NAME_STOPWORDS.has(token)
      && text.includes(` ${token} `)))
    .map(({ row }) => row);
};

/**
 * `findNamedAccounts` across both ledgers at once, so the full-name rule holds across them too:
 * "ramesh gupta ka kitna baaki hai" is the customer Ramesh Gupta, not him *and* the supplier Gupta
 * Fruits because the supplier list, searched on its own, found no full name and fell back to a word.
 */
const findNamedInBooks = (question = "", customers = [], suppliers = []) => {
  const tagged = [
    ...(Array.isArray(customers) ? customers : []).filter(Boolean).map((row) => ({ side: "customer", row, name: nameOfAccount(row) })),
    ...(Array.isArray(suppliers) ? suppliers : []).filter(Boolean).map((row) => ({ side: "supplier", row, name: nameOfAccount(row) })),
  ];
  const found = findNamedAccounts(question, tagged);
  return {
    customers: found.filter((entry) => entry.side === "customer").map((entry) => entry.row),
    suppliers: found.filter((entry) => entry.side === "supplier").map((entry) => entry.row),
  };
};

// Words that sit where a name would in "X ka kitna baaki hai" but are not one: question words,
// pronouns, periods and the ledger's own nouns.
const ASKED_NAME_STOPWORDS = new Set([
  ...NAME_STOPWORDS,
  "konse", "kaunse", "konsa", "kaunsa", "kon", "kaun", "kiski", "kiske", "kise", "kisne", "kisi",
  "sab", "sabka", "sabki", "sabhi", "total", "kul", "is", "iss", "us", "uss", "es", "mahine", "mahina",
  "month", "week", "hafte", "saal", "year", "abhi", "ab", "aur", "or", "my", "our", "all", "any", "your",
  "a", "an", "of", "in", "it", "this", "that", "tum", "aap", "unka", "uska", "iska", "hamara", "humara",
  "grahak", "vyapari", "maal", "stock", "sale", "sales", "shop", "dukan", "dukaan", "does", "do", "did",
  "much", "many", "how", "what", "me", "us", "we", "i", "log", "logo", "logon", "wala", "wale", "wali",
]);

const NAME_CAPTURE = "([a-z][a-z0-9.&'-]*(?:\\s+[a-z][a-z0-9.&'-]*)?)";
const ASKED_NAME_PATTERNS = [
  new RegExp(`${NAME_CAPTURE}\\s+(?:ka|ki|ke|se|ko|ne)\\s+(?:kitna|kitni|kitne|ktna|paisa|paise|payment|udhaar|udhar|udhari|baaki|baki|bakaya|hisab|hisaab|balance|due|dues)\\b`),
  new RegExp(`\\bhow\\s+much\\s+(?:does|do|did|is)\\s+${NAME_CAPTURE}\\s+(?:owe|owes|have\\s+to\\s+pay|pending|due)\\b`),
  new RegExp(`\\bhow\\s+much\\s+(?:do|does|did)\\s+(?:i|we)\\s+owe\\s+${NAME_CAPTURE}`),
  new RegExp(`\\bwhat\\s+(?:does|do)\\s+${NAME_CAPTURE}\\s+owe\\b`),
  new RegExp(`\\b(?:balance|dues|due|outstanding)\\s+(?:of|for|from)\\s+${NAME_CAPTURE}`),
];

/**
 * The name a question asks about, as he typed it, or "" when it asks about no one in particular.
 *
 * Only used when `findNamedAccounts` found nothing, to tell "which customer owes the most" (no
 * name, answer the ranking) from "suresh ka kitna baaki hai" about a Suresh the books have never
 * seen (a name, and saying so is the answer). Answering the second with the ranking would be an
 * answer about somebody else, which is worse than none.
 */
const detectAskedName = (question = "") => {
  const text = String(question || "").toLowerCase().replace(/[?!,]+/g, " ").replace(/\s+/g, " ").trim();
  for (const pattern of ASKED_NAME_PATTERNS) {
    const match = pattern.exec(text);
    if (!match) continue;
    const tokens = match[1].split(/\s+/).filter(Boolean);
    while (tokens.length && ASKED_NAME_STOPWORDS.has(tokens[0])) tokens.shift();
    while (tokens.length && ASKED_NAME_STOPWORDS.has(tokens[tokens.length - 1])) tokens.pop();
    const name = tokens.join(" ");
    if (name.replace(/\s+/g, "").length >= 3) return name;
  }
  return "";
};

const titleCase = (text) => String(text || "").split(" ").map((word) => (word ? word[0].toUpperCase() + word.slice(1) : word)).join(" ");

/* ------------------------------------------------------------------------- the answer */

const plural = (count, singular, pluralWord) => `${count} ${Number(count) === 1 ? singular : pluralWord}`;
const listOf = (items) => (items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const DUE_LIST_LIMIT = 5;
const NEXT_LIMIT = 2;

/**
 * FROST's answer to a dues question, and the fact that grounds it.
 *
 * Returns `{ answer, focus, rows, summary }`. `rows` and `summary` are the `payments_due` fact: they
 * hold every name, amount, day label and count the sentence prints, including the ones worked out
 * here -- days overdue, "and 3 more", "14 customers", "10 Sep". `assertGroundedAnswer` reads the
 * facts as text and demands that every number in the answer occurs there, so a figure derived in
 * this function and printed without being written into the fact would read as invented.
 *
 * No period prefix. A balance is not a period figure: "Today: Ramesh owes you ₹12,000" suggests a
 * day's trading, when the ₹12,000 may be six weeks old.
 *
 * `customers` and `suppliers` are the full ledgers from `buildCustomerLedger`/`buildSupplierLedger`
 * (zero balances included); `paymentsDue` is `buildPaymentsDue`'s payload for the same day.
 */
const buildDuesAnswer = ({ question = "", customers = [], suppliers = [], paymentsDue = {} } = {}) => {
  const date = paymentsDue.date || null;
  const focus = detectDuesFocus(question);
  const owing = (Array.isArray(customers) ? customers : []).filter((row) => Number(row.outstanding_amount) > 0)
    .sort(byAmount("customer_name"));
  const owed = (Array.isArray(suppliers) ? suppliers : []).filter((row) => Number(row.outstanding_amount) > 0)
    .sort(byAmount("supplier_name"));
  const reminderFor = (list, idField, id) => (Array.isArray(list) ? list : [])
    .find((row) => idKey(row[idField]) === idKey(id))?.payment_reminder || null;

  const rows = [];
  const summary = {
    date,
    date_label: shortDay(date),
    focus,
    customer_count: owing.length,
    customer_total: fromPaise(owing.reduce((sum, row) => sum + toPaise(row.outstanding_amount), 0)),
    supplier_count: owed.length,
    supplier_total: fromPaise(owed.reduce((sum, row) => sum + toPaise(row.outstanding_amount), 0)),
  };
  const sentences = [];

  const customerRow = (row, role) => {
    const fact = {
      role,
      account: "customer",
      customer_id: row.customer_id ?? null,
      customer_name: row.customer_name,
      outstanding_amount: round2(row.outstanding_amount),
      unpaid_since: row.unpaid_since || null,
      unpaid_since_label: shortDay(row.unpaid_since),
      next_due_date: row.next_due_date || null,
      next_due_label: shortDay(row.next_due_date),
      overdue_days: row.next_due_date && date ? daysBetween(row.next_due_date, date) : null,
      last_payment_date: row.last_payment_date || null,
      last_payment_label: shortDay(row.last_payment_date),
    };
    rows.push(fact);
    return fact;
  };
  const supplierRow = (row, role) => {
    const fact = {
      role,
      account: "supplier",
      supplier_id: row.supplier_id ?? null,
      supplier_name: row.supplier_name,
      outstanding_amount: round2(row.outstanding_amount),
      oldest_purchase_date: row.oldest_purchase_date || null,
      oldest_purchase_label: shortDay(row.oldest_purchase_date),
    };
    rows.push(fact);
    return fact;
  };

  const customerRanking = () => {
    if (!owing.length) return "No customer owes you anything right now.";
    const top = customerRow(owing[0], "top_customer");
    const detail = [
      top.unpaid_since_label ? `unpaid since ${top.unpaid_since_label}` : "",
      top.next_due_label ? `due ${top.next_due_label}` : "",
    ].filter(Boolean);
    const tail = detail.length ? `, ${detail.join(", ")}` : "";
    if (owing.length === 1) return `Only ${top.customer_name} owes you: ${money(top.outstanding_amount)}${tail}.`;
    const next = owing.slice(1, 1 + NEXT_LIMIT).map((row) => customerRow(row, "next_customer"));
    return `${top.customer_name} owes you the most: ${money(top.outstanding_amount)}${tail}.`
      + ` Next: ${next.map((row) => `${row.customer_name} ${money(row.outstanding_amount)}`).join(", ")}.`
      + ` In all, ${plural(summary.customer_count, "customer owes", "customers owe")} you ${money(summary.customer_total)}.`;
  };

  const supplierRanking = () => {
    if (!owed.length) return "You owe no supplier anything right now.";
    const top = supplierRow(owed[0], "top_supplier");
    const tail = top.oldest_purchase_label ? `, unpaid since ${top.oldest_purchase_label}` : "";
    if (owed.length === 1) return `You owe only ${top.supplier_name}: ${money(top.outstanding_amount)}${tail}.`;
    const next = owed.slice(1, 1 + NEXT_LIMIT).map((row) => supplierRow(row, "next_supplier"));
    return `You owe ${top.supplier_name} the most: ${money(top.outstanding_amount)}${tail}.`
      + ` Next: ${next.map((row) => `${row.supplier_name} ${money(row.outstanding_amount)}`).join(", ")}.`
      + ` In all, you owe ${plural(summary.supplier_count, "supplier", "suppliers")} ${money(summary.supplier_total)}.`;
  };

  // Why an account is on today's list, in the fewest words that still say which day.
  const dueReason = (row) => {
    const days = Number(row.overdue_days) || 0;
    if (row.source === "REMINDER") return days === 0 ? "reminder for today" : `reminder from ${shortDay(row.due_date)}`;
    return days === 0 ? "due today" : `due ${shortDay(row.due_date)}, ${plural(days, "day", "days")} late`;
  };

  const dueRow = (row, role, nameField) => {
    const fact = {
      role,
      account: nameField === "customer_name" ? "customer" : "supplier",
      key: row.key,
      [nameField]: row[nameField],
      outstanding_amount: round2(row.outstanding_amount),
      due_date: row.due_date,
      due_label: shortDay(row.due_date),
      overdue_days: row.overdue_days,
      source: row.source,
      reminder_id: row.reminder_id ?? null,
      settled: row.settled === true,
    };
    rows.push(fact);
    return fact;
  };

  const settledSentence = (settled, nameField) => {
    if (!settled.length) return "";
    const names = settled.map((row) => dueRow(row, "settled", nameField)[nameField]);
    return nameField === "customer_name"
      ? ` ${listOf(names)} had a reminder due but ${names.length === 1 ? "owes" : "owe"} nothing now, so ${names.length === 1 ? "it" : "those"} can be closed.`
      : ` A payment reminder for ${listOf(names)} is due, but nothing is owed now, so ${names.length === 1 ? "it" : "those"} can be closed.`;
  };

  const todayCollect = () => {
    const list = Array.isArray(paymentsDue.collect) ? paymentsDue.collect : [];
    const active = list.filter((row) => row.settled !== true);
    const settled = list.filter((row) => row.settled === true);
    summary.collect_count = active.length;
    summary.collect_total = fromPaise(active.reduce((sum, row) => sum + toPaise(row.outstanding_amount), 0));
    let sentence;
    if (!active.length) {
      sentence = "Nobody is due to pay you today.";
    } else {
      const shown = active.slice(0, DUE_LIST_LIMIT).map((row) => dueRow(row, "collect", "customer_name"));
      summary.collect_more = Math.max(0, active.length - shown.length);
      const items = shown.map((row) => `${row.customer_name} ${money(row.outstanding_amount)} (${dueReason(row)})`);
      if (summary.collect_more) items.push(`${summary.collect_more} more`);
      sentence = `Collect today from ${plural(active.length, "customer", "customers")}: ${items.join(", ")}.`;
      if (active.length > 1) sentence += ` ${money(summary.collect_total)} in all.`;
    }
    return sentence + settledSentence(settled, "customer_name");
  };

  const todayPay = () => {
    const list = Array.isArray(paymentsDue.pay) ? paymentsDue.pay : [];
    const active = list.filter((row) => row.settled !== true);
    const settled = list.filter((row) => row.settled === true);
    summary.pay_count = active.length;
    summary.pay_total = fromPaise(active.reduce((sum, row) => sum + toPaise(row.outstanding_amount), 0));
    let sentence;
    if (!active.length) {
      // Suppliers carry no due date in the books, so "nothing due" can only mean "no reminder of
      // yours falls today" -- said that way, with what is owed in all beside it, so an empty list
      // is not read as "you owe nobody".
      sentence = "No supplier payment reminder falls due today.";
      if (owed.length) sentence += ` You owe ${plural(summary.supplier_count, "supplier", "suppliers")} ${money(summary.supplier_total)} in all.`;
    } else {
      const shown = active.slice(0, DUE_LIST_LIMIT).map((row) => dueRow(row, "pay", "supplier_name"));
      summary.pay_more = Math.max(0, active.length - shown.length);
      const items = shown.map((row) => `${row.supplier_name} ${money(row.outstanding_amount)} (${dueReason(row)})`);
      if (summary.pay_more) items.push(`${summary.pay_more} more`);
      sentence = `Pay today: ${items.join(", ")}.`;
      if (active.length > 1) sentence += ` ${money(summary.pay_total)} in all.`;
    }
    return sentence + settledSentence(settled, "supplier_name");
  };

  const namedCustomer = (account) => {
    const row = customerRow(account, "named_customer");
    const parts = [];
    if (row.outstanding_amount <= 0) {
      parts.push(`${row.customer_name} owes you nothing now.`);
    } else {
      parts.push(`${row.customer_name} owes you ${money(row.outstanding_amount)}.`);
      if (row.next_due_label && row.overdue_days !== null) {
        if (row.overdue_days > 0) parts.push(`The oldest unpaid bill was due on ${row.next_due_label}, ${plural(row.overdue_days, "day", "days")} ago.`);
        else if (row.overdue_days === 0) parts.push("The oldest unpaid bill is due today.");
        else parts.push(`The oldest unpaid bill is due on ${row.next_due_label}.`);
      } else if (row.unpaid_since_label) {
        parts.push(`Unpaid since ${row.unpaid_since_label}; that bill carries no due date.`);
      }
    }
    parts.push(row.last_payment_label ? `Last payment ${row.last_payment_label}.` : "No payment recorded yet.");
    const reminder = reminderFor(paymentsDue.customers, "customer_id", row.customer_id);
    if (reminder?.due_at) {
      row.reminder_label = shortDay(reminder.due_at);
      parts.push(`Reminder to collect on ${row.reminder_label}.`);
    }
    return parts.join(" ");
  };

  const namedSupplier = (account) => {
    const row = supplierRow(account, "named_supplier");
    const parts = [];
    if (row.outstanding_amount <= 0) {
      parts.push(`You owe ${row.supplier_name} nothing now.`);
    } else {
      const tail = row.oldest_purchase_label ? `, unpaid since ${row.oldest_purchase_label}` : "";
      parts.push(`You owe ${row.supplier_name} ${money(row.outstanding_amount)}${tail}.`);
    }
    const reminder = reminderFor(paymentsDue.suppliers, "supplier_id", row.supplier_id);
    if (reminder?.due_at) {
      row.reminder_label = shortDay(reminder.due_at);
      parts.push(`Reminder to pay on ${row.reminder_label}.`);
    }
    return parts.join(" ");
  };

  const { customers: namedCustomers, suppliers: namedSuppliers } = findNamedInBooks(question, customers, suppliers);
  if (namedCustomers.length || namedSuppliers.length) {
    summary.named_count = namedCustomers.length + namedSuppliers.length;
    if (summary.named_count > 1) {
      sentences.push(`${summary.named_count} accounts match that name.`);
    }
    for (const account of namedCustomers) sentences.push(namedCustomer(account));
    for (const account of namedSuppliers) sentences.push(namedSupplier(account));
    return { answer: sentences.join(" "), focus: "named", rows, summary };
  }

  const asked = detectAskedName(question);
  if (asked) {
    summary.asked_name = titleCase(asked);
    return {
      answer: `I could not find ${summary.asked_name} among the customers or suppliers with a credit account, so I have no balance to give.`,
      focus: "not_found",
      rows,
      summary,
    };
  }

  if (focus === "customer") sentences.push(customerRanking());
  else if (focus === "supplier") sentences.push(supplierRanking());
  else if (focus === "today_collect") sentences.push(todayCollect());
  else if (focus === "today_pay") sentences.push(todayPay());
  else if (focus === "today_both") sentences.push(todayCollect(), todayPay());
  else sentences.push(customerRanking(), supplierRanking());
  return { answer: sentences.join(" "), focus, rows, summary };
};

/* ------------------------------------------------------------------------- reminder linkage */

/**
 * Which account a spoken reminder is about, when that is certain -- or null.
 *
 * "xyz ko payment dena hai yaad dilana" about a known supplier becomes a PAY_SUPPLIER reminder
 * linked to that supplier, so it pops up on the day with the balance beside it; "abc se paisa lena
 * hai" about a known customer becomes COLLECT_PAYMENT. Anything less than certain stays an owner
 * note: two matching accounts, a customer spoken of with paying words, or words that point both
 * ways. A reminder linked to the wrong account would show the wrong balance on the wrong day, and
 * an unlinked note loses nothing -- he can still read his own words.
 */
const linkReminderDraft = ({ question = "", title = "", customers = [], suppliers = [] } = {}) => {
  const text = String(question || title || "");
  const lowered = text.toLowerCase();
  const { customers: namedCustomers, suppliers: namedSuppliers } = findNamedInBooks(text, customers, suppliers);
  if (namedCustomers.length + namedSuppliers.length !== 1) return null;
  const collect = COLLECT_WORDS.test(lowered);
  const pay = PAY_WORDS.test(lowered);
  if (collect === pay) return null;
  if (namedSuppliers.length === 1 && pay) {
    const supplier = namedSuppliers[0];
    return {
      reminder_type: "PAY_SUPPLIER",
      linked_entity_type: "supplier",
      linked_entity_id: idKey(supplier.supplier_id),
      linked_entity_name: nameOfAccount(supplier),
    };
  }
  if (namedCustomers.length === 1 && collect) {
    const customer = namedCustomers[0];
    return {
      reminder_type: "COLLECT_PAYMENT",
      linked_entity_type: "customer",
      linked_entity_id: idKey(customer.customer_id),
      linked_entity_name: nameOfAccount(customer),
    };
  }
  return null;
};

/** Every pattern whose alternatives the tests walk. */
const DUES_PATTERNS = Object.freeze({ TODAY_WORDS, RANKING_WORDS, CUSTOMER_NOUNS, SUPPLIER_NOUNS, COLLECT_WORDS, PAY_WORDS });

module.exports = {
  DUES_PATTERNS,
  PAYMENTS_DUE_DATE_WINDOW_DAYS,
  buildCustomerLedger,
  buildDuesAnswer,
  buildPaymentsDue,
  buildSupplierLedger,
  dayKey,
  daysBetween,
  detectAskedName,
  detectDuesFocus,
  findNamedAccounts,
  findNamedInBooks,
  idKey,
  linkReminderDraft,
  nextUnpaidDueDates,
  resolvePaymentsDueDate,
  shortDay,
};
