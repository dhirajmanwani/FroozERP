"use strict";

/**
 * FROST per account: FIFO due dates, today's collect/pay list, the dues answer and the route.
 *
 * Dhiraj asked "konse customer ka paisa sabse zyada due hai" and was given the shop's whole dues
 * total; he asked to be told on the day "aaj ABC se payment maangna hai" and nothing could. The pure
 * half is tested directly against `frostAccounts.js`. The route half is driven through the real
 * Express app with a scripted database, in the style of `aiAlertStatusScope.test.js`: the responder
 * reads the bound branch and answers with that branch's rows only, so a query that dropped its
 * predicate would hand back the other shop's customers here exactly as it would in production.
 *
 * Every answer shape is put through `assertGroundedAnswer` with `generated: true` -- the strict
 * check the route applies to a model's words. The dues answer prints figures it worked out itself
 * (days overdue, "3 customers", "10 Sep"), and the only way those are not "invented" is for the
 * fact to carry them. These tests are what hold that.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const path = require("node:path");

const {
  DUES_PATTERNS,
  buildCustomerLedger,
  buildDuesAnswer,
  buildPaymentsDue,
  buildSupplierLedger,
  dayKey,
  detectAskedName,
  detectDuesFocus,
  findNamedAccounts,
  linkReminderDraft,
  nextUnpaidDueDates,
  resolvePaymentsDueDate,
  shortDay,
} = require("./frostAccounts");
const { assertGroundedAnswer } = require("./aiBusinessAssistantRules");
const { classifyBusinessIntent } = require("./frostCore");

/* ------------------------------------------------------------------------------ fixtures */

const DAY = "2026-09-23";

// Ramesh: three bills, one payment that covers the first. Suresh: not yet due, but reminded today.
// Mahesh: due today. Kiran: paid in full, with an old due date and a reminder from yesterday.
const BILLS = [
  { id: 101, customer_id: 1, customer_name: "Ramesh", sale_date: "2026-09-01", due_date: "2026-09-08", total_amount: 3000 },
  { id: 102, customer_id: 1, customer_name: "Ramesh", sale_date: "2026-09-03", due_date: "2026-09-10", total_amount: 10000 },
  { id: 103, customer_id: 1, customer_name: "Ramesh", sale_date: "2026-09-12", due_date: "2026-09-19", total_amount: 2000 },
  { id: 201, customer_id: 2, customer_name: "Suresh", sale_date: "2026-09-15", due_date: "2026-09-30", total_amount: 8000 },
  { id: 301, customer_id: 3, customer_name: "Mahesh", sale_date: "2026-09-20", due_date: "2026-09-23", total_amount: 5500 },
  { id: 401, customer_id: 4, customer_name: "Kiran", sale_date: "2026-08-01", due_date: "2026-08-05", total_amount: 1500 },
];
const CREDITS = [
  { customer_id: 1, customer_name: "Ramesh", paid_amount: 3000, returned_amount: 0, last_payment_date: "2026-09-15" },
  { customer_id: 4, customer_name: "Kiran", paid_amount: 1500, returned_amount: 0, last_payment_date: "2026-09-20" },
];
const SUPPLIERS = [
  { supplier_id: 9, supplier_name: "Verma Traders", outstanding_amount: 40000, oldest_purchase_date: "2026-09-02" },
  { supplier_id: 8, supplier_name: "Gupta Fruits", outstanding_amount: 30000, oldest_purchase_date: "2026-09-10" },
  { supplier_id: 7, supplier_name: "Shah Mandi", outstanding_amount: 20000, oldest_purchase_date: "2026-09-12" },
  { supplier_id: 6, supplier_name: "Paid Up Co", outstanding_amount: 0, oldest_purchase_date: null },
];
const REMINDERS = [
  { id: 55, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "2", due_at: "2026-09-23T00:00:00", currently_snoozed: false },
  { id: 56, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "4", due_at: "2026-09-22T00:00:00", currently_snoozed: false },
  { id: 57, reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "9", due_at: "2026-09-23T00:00:00", currently_snoozed: false },
];
const INPUTS = { customers: CREDITS, customerBills: BILLS, suppliers: SUPPLIERS, reminders: REMINDERS };

const answerFor = (question, inputs = INPUTS, date = DAY) => {
  const paymentsDue = buildPaymentsDue({ date, ...inputs });
  const result = buildDuesAnswer({
    question,
    customers: buildCustomerLedger(inputs),
    suppliers: buildSupplierLedger(inputs.suppliers),
    paymentsDue,
  });
  return { ...result, paymentsDue };
};

// The strict check, exactly as the route applies it to a model's words: every number in the
// answer must occur in the facts. Only this answer's own fact is offered, so it cannot lean on a
// figure that happened to be in some other fact.
const assertGrounded = (result) => {
  assert.ok(
    assertGroundedAnswer({ answer: result.answer, facts: [{ rows: result.rows, summary: result.summary }], generated: true }),
    `not grounded: ${result.answer}`,
  );
};

/* ------------------------------------------------------------------------------ FIFO */

test("FIFO: a payment settles the oldest bill first, and the first bill it does not cover gives the date", () => {
  const fifo = nextUnpaidDueDates({ bills: BILLS, credits: CREDITS });
  const ramesh = fifo.get("1");
  // 3000 paid against 3000 + 10000 + 2000. Bill 101 is covered; 102 is where the debt starts.
  assert.equal(ramesh.next_due_date, "2026-09-10");
  assert.equal(ramesh.next_due_bill_id, 102);
  assert.equal(ramesh.unpaid_since, "2026-09-03");
  assert.equal(ramesh.outstanding_amount, 12000);
});

test("FIFO: partial payments across three bills land on the right bill", () => {
  const bills = [
    { id: "a", customer_id: 7, sale_date: "2026-09-01", due_date: "2026-09-05", total_amount: 1000 },
    { id: "b", customer_id: 7, sale_date: "2026-09-02", due_date: "2026-09-06", total_amount: 1000 },
    { id: "c", customer_id: 7, sale_date: "2026-09-03", due_date: "2026-09-07", total_amount: 1000 },
  ];
  const at = (paid, returned = 0) => nextUnpaidDueDates({ bills, credits: [{ customer_id: 7, paid_amount: paid, returned_amount: returned }] }).get("7");
  assert.equal(at(0).next_due_date, "2026-09-05");
  assert.equal(at(999.99).next_due_date, "2026-09-05", "a bill short by a paisa is not covered");
  assert.equal(at(1000).next_due_date, "2026-09-06");
  assert.equal(at(1500).next_due_date, "2026-09-06", "half of the second bill leaves the second bill due");
  // Credit-note returns pay down bills exactly like cash does.
  assert.equal(at(1000, 1000).next_due_date, "2026-09-07");
  assert.equal(at(2999.99).next_due_date, "2026-09-07");
  assert.equal(at(3000).next_due_date, null, "fully paid: nothing is due");
  assert.equal(at(3000).outstanding_amount, 0);
  // Float sums of rupees must not leave a paid bill "short": 0.1 + 0.2 is not 0.3 in floating point.
  const tiny = [
    { id: 1, customer_id: 8, sale_date: "2026-09-01", due_date: "2026-09-02", total_amount: 0.3 },
    { id: 2, customer_id: 8, sale_date: "2026-09-02", due_date: "2026-09-03", total_amount: 5 },
  ];
  const credits = [{ customer_id: 8, paid_amount: 0.1 }, { customer_id: 8, paid_amount: 0.2 }];
  assert.equal(nextUnpaidDueDates({ bills: tiny, credits }).get("8").next_due_date, "2026-09-03");
});

test("FIFO orders by sale date, keeping the query's order for bills of the same day", () => {
  const bills = [
    { id: "late", customer_id: 1, sale_date: "2026-09-10", due_date: "2026-09-20", total_amount: 100 },
    { id: "first", customer_id: 1, sale_date: "2026-09-01", due_date: "2026-09-05", total_amount: 100 },
    { id: "second", customer_id: 1, sale_date: "2026-09-01", due_date: "2026-09-06", total_amount: 100 },
  ];
  const next = nextUnpaidDueDates({ bills, credits: [{ customer_id: 1, paid_amount: 100 }] }).get("1");
  assert.equal(next.next_due_bill_id, "second");
});

test("a bill with no due date gives no date, and does not hide the dated bill behind it", () => {
  const bills = [
    { id: 1, customer_id: 5, sale_date: "2026-09-01", due_date: null, total_amount: 500 },
    { id: 2, customer_id: 5, sale_date: "2026-09-02", due_date: "2026-09-09", total_amount: 500 },
  ];
  const next = nextUnpaidDueDates({ bills, credits: [] }).get("5");
  assert.equal(next.unpaid_since, "2026-09-01", "the debt starts at the undated bill");
  assert.equal(next.next_due_date, "2026-09-09", "the date comes from the first uncovered bill that has one");
  const undated = nextUnpaidDueDates({ bills: [bills[0]], credits: [] }).get("5");
  assert.equal(undated.next_due_date, null, "a customer given no due date is not overdue");
});

test("\"004\" and 4 are two different customers", () => {
  const bills = [
    { id: 1, customer_id: "004", customer_name: "Zero Four", sale_date: "2026-09-01", due_date: "2026-09-05", total_amount: 700 },
    { id: 2, customer_id: 4, customer_name: "Four", sale_date: "2026-09-01", due_date: "2026-09-05", total_amount: 700 },
  ];
  // Four has paid. If the ids were coerced with Number(), Zero Four's bill would be paid off too.
  const credits = [{ customer_id: 4, paid_amount: 700 }];
  const fifo = nextUnpaidDueDates({ bills, credits });
  assert.equal(fifo.get("004").next_due_date, "2026-09-05");
  assert.equal(fifo.get("004").outstanding_amount, 700);
  assert.equal(fifo.get("4").next_due_date, null);
  const payload = buildPaymentsDue({ date: DAY, customers: credits, customerBills: bills });
  assert.deepEqual(payload.collect.map((row) => row.key), ["customer:004"]);
  assert.deepEqual(payload.customers.map((row) => row.customer_id), ["004"]);
  // And a reminder linked to "4" is not Zero Four's.
  const withReminder = buildPaymentsDue({
    date: DAY,
    customers: credits,
    customerBills: bills,
    reminders: [{ id: 1, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "4", due_at: DAY }],
  });
  const four = withReminder.collect.find((row) => row.key === "customer:4");
  assert.equal(four.settled, true);
  assert.equal(withReminder.collect.find((row) => row.key === "customer:004").source, "BILL");
});

/* ------------------------------------------------------------------------------ days */

test("a day is read the same way on a laptop in India and a server in UTC", () => {
  // `pg`'s default parser hands a DATE back as local midnight. Reading that with toISOString() in
  // India gives the day before, which is how every reminder once showed a day early.
  const script = `
    const { dayKey, buildPaymentsDue } = require(${JSON.stringify(path.join(__dirname, "frostAccounts.js"))});
    const payload = buildPaymentsDue({
      date: "2026-09-23",
      customers: [],
      customerBills: [{ id: 1, customer_id: 1, customer_name: "A", sale_date: new Date(2026, 8, 1), due_date: new Date(2026, 8, 10), total_amount: 100 }],
    });
    process.stdout.write(JSON.stringify([dayKey(new Date(2026, 8, 10)), dayKey(new Date(2026, 8, 10, 23, 59)), payload.collect[0].due_date, payload.collect[0].overdue_days]));
  `;
  for (const tz of ["UTC", "Asia/Kolkata", "America/Los_Angeles"]) {
    const output = execFileSync(process.execPath, ["-e", script], { env: { ...process.env, TZ: tz } }).toString();
    assert.deepEqual(JSON.parse(output), ["2026-09-10", "2026-09-10", "2026-09-10", 13], `in ${tz}`);
  }
  assert.equal(dayKey("2026-09-10"), "2026-09-10");
  assert.equal(dayKey("2026-09-10T00:00:00"), "2026-09-10", "a reminder's wall-clock due_at");
  assert.equal(dayKey("2026-02-31"), null);
  assert.equal(dayKey(null), null);
  assert.equal(shortDay("2026-09-03"), "3 Sep");
});

test("the requested day is a real date within two days of the server's day, or refused", () => {
  assert.equal(resolvePaymentsDueDate(undefined, "2026-09-23"), "2026-09-23");
  assert.equal(resolvePaymentsDueDate("", "2026-09-23"), "2026-09-23");
  // IST is ahead of UTC: before 05:30 IST the laptop's day is the server's tomorrow.
  assert.equal(resolvePaymentsDueDate("2026-09-24", "2026-09-23"), "2026-09-24");
  assert.equal(resolvePaymentsDueDate("2026-09-21", "2026-09-23"), "2026-09-21");
  assert.equal(resolvePaymentsDueDate("2026-09-26", "2026-09-23"), null);
  assert.equal(resolvePaymentsDueDate("2026-09-20", "2026-09-23"), null);
  assert.equal(resolvePaymentsDueDate("2026-02-31", "2026-02-28"), null);
  assert.equal(resolvePaymentsDueDate("23-09-2026", "2026-09-23"), null);
  assert.equal(resolvePaymentsDueDate("today", "2026-09-23"), null);
  assert.equal(resolvePaymentsDueDate(["2026-09-23", "2026-09-24"], "2026-09-23"), null);
  // Across a month end, which string arithmetic on the day number would get wrong.
  assert.equal(resolvePaymentsDueDate("2026-10-01", "2026-09-30"), "2026-10-01");
});

/* ------------------------------------------------------------------------------ payments due */

test("collect: due bills and due reminders, one row per customer, the reminder winning", () => {
  const payload = buildPaymentsDue({ date: DAY, ...INPUTS });
  assert.equal(payload.date, DAY);
  assert.equal(payload.action_class, "READ_ONLY");
  const byKey = Object.fromEntries(payload.collect.map((row) => [row.key, row]));
  assert.deepEqual(Object.keys(byKey).sort(), ["customer:1", "customer:2", "customer:3", "customer:4"]);
  assert.deepEqual(byKey["customer:1"], {
    key: "customer:1", customer_id: 1, customer_name: "Ramesh", outstanding_amount: 12000,
    due_date: "2026-09-10", overdue_days: 13, source: "BILL", reminder_id: null, settled: false,
  });
  // Suresh's bill is not due until the 30th; his reminder for today puts him on the list.
  assert.equal(byKey["customer:2"].source, "REMINDER");
  assert.equal(byKey["customer:2"].reminder_id, 55);
  assert.equal(byKey["customer:2"].due_date, DAY);
  assert.equal(byKey["customer:3"].overdue_days, 0);
  // Kiran paid up after the reminder was set: shown, settled, so it can be closed.
  assert.equal(byKey["customer:4"].settled, true);
  assert.equal(byKey["customer:4"].outstanding_amount, 0);
  // Most overdue first, then the larger amount.
  assert.deepEqual(payload.collect.map((row) => row.customer_name), ["Ramesh", "Kiran", "Suresh", "Mahesh"]);
});

test("a reminder for a customer whose bill is also due still gives one row, sourced from the reminder", () => {
  const reminders = [{ id: 9, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "1", due_at: "2026-09-20T00:00:00" }];
  const payload = buildPaymentsDue({ date: DAY, customers: CREDITS, customerBills: BILLS, reminders });
  const rows = payload.collect.filter((row) => row.key === "customer:1");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "REMINDER");
  assert.equal(rows[0].due_date, "2026-09-20", "the day he chose, not the bill's");
  assert.equal(rows[0].overdue_days, 3);
});

test("a paid-up customer with an old due date is not on the list", () => {
  const payload = buildPaymentsDue({ date: DAY, customers: CREDITS, customerBills: BILLS });
  assert.ok(!payload.collect.some((row) => row.customer_name === "Kiran"), "Kiran's 5 Aug bill is paid");
  assert.ok(!payload.customers.some((row) => row.customer_name === "Kiran"));
});

test("a future bill, a future reminder, an undated reminder and a live snooze are not due", () => {
  const reminders = [
    { id: 1, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "3", due_at: "2026-09-25T00:00:00" },
    { id: 2, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "2", due_at: null },
    { id: 3, reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "8", due_at: "2026-09-22T00:00:00", currently_snoozed: true },
    // An owner note with a customer link is not a payment reminder.
    { id: 4, reminder_type: "OWNER_NOTE", linked_entity_type: "customer", linked_entity_id: "2", due_at: DAY },
  ];
  const payload = buildPaymentsDue({ date: "2026-09-22", customers: CREDITS, customerBills: BILLS, suppliers: SUPPLIERS, reminders });
  assert.deepEqual(payload.collect.map((row) => row.customer_name), ["Ramesh"]);
  assert.deepEqual(payload.pay, [], "a snoozed reminder stays quiet until its snooze runs out");
  // The panel still shows that a reminder exists -- the snoozed one included.
  assert.deepEqual(payload.suppliers.find((row) => row.supplier_id === 8).payment_reminder, { id: 3, due_at: "2026-09-22" });
  assert.deepEqual(payload.customers.find((row) => row.customer_id === 3).payment_reminder, { id: 1, due_at: "2026-09-25" });
  assert.equal(payload.customers.find((row) => row.customer_id === 2).payment_reminder, null, "an undated reminder cannot be shown as a day");
});

test("pay: supplier reminders only, with the balance, settled when nothing is owed", () => {
  const reminders = [
    ...REMINDERS,
    { id: 60, reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "6", due_at: "2026-09-21T00:00:00" },
    { id: 61, reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "99", due_at: DAY, linked_entity_name: "Gone Traders" },
  ];
  const payload = buildPaymentsDue({ date: DAY, ...INPUTS, reminders });
  assert.deepEqual(payload.pay.map((row) => [row.supplier_name, row.outstanding_amount, row.settled, row.overdue_days]), [
    ["Paid Up Co", 0, true, 2],
    ["Verma Traders", 40000, false, 0],
    ["Gone Traders", 0, true, 0],
  ]);
  assert.equal(payload.pay[1].key, "supplier:9");
  assert.equal(payload.pay[1].reminder_id, 57);
  // The panel list is who is owed money, largest first.
  assert.deepEqual(payload.suppliers.map((row) => row.supplier_name), ["Verma Traders", "Gupta Fruits", "Shah Mandi"]);
  assert.deepEqual(payload.suppliers[0], {
    supplier_id: 9, supplier_name: "Verma Traders", outstanding_amount: 40000, oldest_purchase_date: "2026-09-02",
    payment_reminder: { id: 57, due_at: DAY },
  });
});

test("the customers list is everyone who owes, largest first, with the next due date", () => {
  const payload = buildPaymentsDue({ date: DAY, ...INPUTS });
  assert.deepEqual(payload.customers, [
    { customer_id: 1, customer_name: "Ramesh", outstanding_amount: 12000, next_due_date: "2026-09-10", payment_reminder: null },
    { customer_id: 2, customer_name: "Suresh", outstanding_amount: 8000, next_due_date: "2026-09-30", payment_reminder: { id: 55, due_at: DAY } },
    { customer_id: 3, customer_name: "Mahesh", outstanding_amount: 5500, next_due_date: "2026-09-23", payment_reminder: null },
  ]);
});

test("a supplier split across two name spellings is one account", () => {
  const ledger = buildSupplierLedger([
    { supplier_id: 3, supplier_name: "Verma", outstanding_amount: 100.1, oldest_purchase_date: "2026-09-05" },
    { supplier_id: 3, supplier_name: "VERMA", outstanding_amount: 200.2, oldest_purchase_date: "2026-09-01" },
  ]);
  assert.equal(ledger.length, 1);
  assert.equal(ledger[0].outstanding_amount, 300.3);
  assert.equal(ledger[0].oldest_purchase_date, "2026-09-01");
});

test("buildPaymentsDue refuses to guess the day", () => {
  assert.throws(() => buildPaymentsDue({ date: "", ...INPUTS }), /FROST_PAYMENTS_DATE_REQUIRED/);
});

/* ------------------------------------------------------------------------------ language */

test("dues focus is read from Hinglish and English", () => {
  const cases = [
    ["which customer owes the most", "customer"],
    ["konse customer ka paisa sabse zyada due hai", "customer"],
    ["who owes me money", "customer"],
    ["kisse paisa lena hai", "customer"],
    ["kiska paisa vasool karna hai", "customer"],
    ["customer ne kitna dena hai", "customer"],
    ["kis supplier ko sabse zyada dena hai", "supplier"],
    ["which supplier do i owe most", "supplier"],
    ["kisko paisa chukana hai", "supplier"],
    ["how much do i owe", "supplier"],
    ["aaj kisse payment maangna hai", "today_collect"],
    ["customer dues today", "today_collect"],
    ["aaj kisko payment dena hai", "today_pay"],
    ["aaj kise paisa chukana hai", "today_pay"],
    ["aaj ka payment", "today_both"],
    ["dues", "both"],
    ["udhaar", "both"],
    ["kitna udhaar baaki hai", "both"],
    // "pay attention" is not paying.
    ["aaj kya dhyan dena hai", "today_both"],
    // A ranking question keeps the ranking even when it says today.
    ["aaj sabse zyada kiska baaki hai", "both"],
  ];
  for (const [question, focus] of cases) assert.equal(detectDuesFocus(question), focus, question);
});

test("every dues question in the contract reaches PAYMENTS", () => {
  for (const question of [
    "which customer owes the most", "konse customer ka paisa sabse zyada due hai", "kis supplier ko sabse zyada dena hai",
    "ramesh ka kitna baaki hai", "aaj kisse payment maangna hai", "aaj kisko payment dena hai", "dues", "udhaar",
    "aaj kiska paisa vasool karna hai", "aaj kise paisa chukana hai",
  ]) {
    assert.equal(classifyBusinessIntent(question), "PAYMENTS", question);
  }
});

test("no dues pattern carries an alternative it cannot match", () => {
  // The trap `frostLanguage.js` fell into twice: `\b(pichl)\b` never matches "pichle". Every plain
  // alternative is tested against its own pattern, and so are the multi-word ones, spelled out.
  for (const [name, pattern] of Object.entries(DUES_PATTERNS)) {
    const source = pattern.source;
    const groups = [...source.matchAll(/\(([^()?]+)\)/g)].map(([, body]) => body);
    let walked = 0;
    for (const body of groups) {
      for (const alternative of body.split("|")) {
        const spelled = alternative.replace(/\\s\*/g, " ").replace(/\\s\+/g, " ").replace(/\\s/g, " ");
        if (!/^[a-z' ]+$/.test(spelled)) continue;
        walked += 1;
        assert.ok(pattern.test(spelled), `${name} cannot match its own alternative "${spelled}"`);
      }
    }
    assert.ok(walked > 0, `${name}: no alternatives were walked`);
  }
});

test("names are found whole-word, case-insensitive, and never from generic or short names", () => {
  const rows = [
    { customer_id: 1, customer_name: "Ramesh" },
    { customer_id: 2, customer_name: "Ramesh Kumar" },
    { customer_id: 3, customer_name: "Ram" },
    { customer_id: 4, customer_name: "Walk-in Customer" },
    { customer_id: 5, customer_name: "Jo" },
    { customer_id: 6, customer_name: "Lena" },
    { customer_id: 7, customer_name: "kalu a17" },
  ];
  const names = (question) => findNamedAccounts(question, rows).map((row) => row.customer_name);
  assert.deepEqual(names("RAMESH ka kitna baaki hai"), ["Ramesh"]);
  assert.deepEqual(names("ramesh kumar ka hisab"), ["Ramesh Kumar"], "the longer full name wins");
  assert.deepEqual(names("ram ka kitna baaki hai"), ["Ram"]);
  assert.deepEqual(names("rameshwar ka kitna"), [], "a name inside another word is not that name");
  assert.deepEqual(names("which customer owes the most"), [], "\"Customer\" is the counter's placeholder, not a person");
  assert.deepEqual(names("jo bhi baaki hai"), [], "two letters are never a name");
  assert.deepEqual(names("abc se paisa lena hai"), [], "a customer called Lena is not in every collect question");
  assert.deepEqual(names("Kalu A17 ka balance"), ["kalu a17"]);
  const suppliers = [{ supplier_id: 9, supplier_name: "Verma Traders" }, { supplier_id: 7, supplier_name: "Shah Fruit Mandi" }];
  assert.deepEqual(findNamedAccounts("verma ko kitna dena hai", suppliers).map((row) => row.supplier_id), [9], "a distinctive word of the name is enough");
  assert.deepEqual(findNamedAccounts("mandi ka kitna dena hai", suppliers), [], "a trade word is not a name");
});

test("a name that is asked about is picked out of the question, and questions about no one are not", () => {
  assert.equal(detectAskedName("naresh ka kitna baaki hai"), "naresh");
  assert.equal(detectAskedName("mujhe dinesh se paisa lena hai"), "dinesh");
  assert.equal(detectAskedName("how much does naresh owe"), "naresh");
  assert.equal(detectAskedName("how much do I owe Bansal Brothers?"), "bansal");
  assert.equal(detectAskedName("konse customer ka paisa sabse zyada due hai"), "");
  assert.equal(detectAskedName("customer ka kitna baaki hai"), "");
  assert.equal(detectAskedName("kitna udhaar baaki hai"), "");
  assert.equal(detectAskedName("aaj ka payment"), "");
  assert.equal(detectAskedName("is mahine ka kitna baaki hai"), "");
});

/* ------------------------------------------------------------------------------ answers */

test("which customer owes the most: names, amounts, since when and due when", () => {
  for (const question of ["which customer owes the most", "konse customer ka paisa sabse zyada due hai"]) {
    const result = answerFor(question);
    assert.equal(result.answer,
      "Ramesh owes you the most: ₹12,000, unpaid since 3 Sep, due 10 Sep. Next: Suresh ₹8,000, Mahesh ₹5,500. In all, 3 customers owe you ₹25,500.");
    assertGrounded(result);
  }
});

test("which supplier do I owe the most", () => {
  const result = answerFor("kis supplier ko sabse zyada dena hai");
  assert.equal(result.answer,
    "You owe Verma Traders the most: ₹40,000, unpaid since 2 Sep. Next: Gupta Fruits ₹30,000, Shah Mandi ₹20,000. In all, you owe 3 suppliers ₹90,000.");
  assertGrounded(result);
});

test("one account by name: balance, the oldest unpaid bill's due date and age, last payment", () => {
  const result = answerFor("ramesh ka kitna baaki hai");
  assert.equal(result.answer, "Ramesh owes you ₹12,000. The oldest unpaid bill was due on 10 Sep, 13 days ago. Last payment 15 Sep.");
  assertGrounded(result);
  const suresh = answerFor("how much does Suresh owe");
  assert.equal(suresh.answer, "Suresh owes you ₹8,000. The oldest unpaid bill is due on 30 Sep. No payment recorded yet. Reminder to collect on 23 Sep.");
  assertGrounded(suresh);
  const kiran = answerFor("kiran ka kitna baaki hai");
  assert.equal(kiran.answer, "Kiran owes you nothing now. Last payment 20 Sep.");
  assertGrounded(kiran);
  const verma = answerFor("verma ko kitna dena hai");
  assert.equal(verma.answer, "You owe Verma Traders ₹40,000, unpaid since 2 Sep. Reminder to pay on 23 Sep.");
  assertGrounded(verma);
});

test("two accounts that both match are both named, not one chosen", () => {
  const inputs = {
    ...INPUTS,
    customerBills: [
      ...BILLS,
      { id: 501, customer_id: 11, customer_name: "Ramesh Gupta", sale_date: "2026-09-10", due_date: "2026-09-17", total_amount: 700 },
    ],
  };
  // The full name wins across both ledgers: not the supplier Gupta Fruits as well.
  const result = answerFor("ramesh gupta ka kitna baaki hai", inputs);
  assert.equal(result.answer, "Ramesh Gupta owes you ₹700. The oldest unpaid bill was due on 17 Sep, 6 days ago. No payment recorded yet.");
  assertGrounded(result);
  // Neither full name is in the question, so the shared word finds both Rameshes.
  const both = answerFor("how much does ramesh owe", {
    ...inputs,
    customerBills: inputs.customerBills.map((bill) => (bill.customer_id === 1 ? { ...bill, customer_name: "Ramesh Kumar" } : bill)),
  });
  assert.match(both.answer, /^2 accounts match that name\. Ramesh Kumar owes you ₹12,000\..* Ramesh Gupta owes you ₹700\./);
  assertGrounded(both);
});

test("a name that is not in the books is said to be missing, and no other account is answered", () => {
  const result = answerFor("naresh ka kitna baaki hai");
  assert.equal(result.answer, "I could not find Naresh among the customers or suppliers with a credit account, so I have no balance to give.");
  assert.doesNotMatch(result.answer, /₹/);
  assertGrounded(result);
});

test("today's lists: who to collect from and who to pay", () => {
  const collect = answerFor("aaj kisse payment maangna hai");
  assert.equal(collect.answer,
    "Collect today from 3 customers: Ramesh ₹12,000 (due 10 Sep, 13 days late), Suresh ₹8,000 (reminder for today), Mahesh ₹5,500 (due today). ₹25,500 in all."
    + " Kiran had a reminder due but owes nothing now, so it can be closed.");
  assertGrounded(collect);
  const pay = answerFor("aaj kisko payment dena hai");
  assert.equal(pay.answer, "Pay today: Verma Traders ₹40,000 (reminder for today).");
  assertGrounded(pay);
  const nothing = answerFor("aaj kisko payment dena hai", { ...INPUTS, reminders: [] });
  assert.equal(nothing.answer, "No supplier payment reminder falls due today. You owe 3 suppliers ₹90,000 in all.");
  assertGrounded(nothing);
  const nobody = answerFor("aaj kisse paisa lena hai", { customers: [], customerBills: [], suppliers: [], reminders: [] });
  assert.equal(nobody.answer, "Nobody is due to pay you today.");
});

test("a long list is cut at five with a grounded count of the rest", () => {
  const customerBills = Array.from({ length: 8 }, (_, index) => ({
    id: index + 1,
    customer_id: index + 1,
    customer_name: `Customer Number ${String.fromCharCode(65 + index)}`,
    sale_date: "2026-09-01",
    due_date: "2026-09-10",
    total_amount: 1000 + index,
  }));
  const result = answerFor("aaj kisse paisa lena hai", { customers: [], customerBills, suppliers: [], reminders: [] });
  assert.match(result.answer, /^Collect today from 8 customers: .*, 3 more\. ₹8,028 in all\.$/);
  assertGrounded(result);
});

test("plain dues: customers first, then suppliers, each with names and amounts", () => {
  for (const question of ["dues", "udhaar"]) {
    const result = answerFor(question);
    assert.equal(result.answer,
      "Ramesh owes you the most: ₹12,000, unpaid since 3 Sep, due 10 Sep. Next: Suresh ₹8,000, Mahesh ₹5,500. In all, 3 customers owe you ₹25,500."
      + " You owe Verma Traders the most: ₹40,000, unpaid since 2 Sep. Next: Gupta Fruits ₹30,000, Shah Mandi ₹20,000. In all, you owe 3 suppliers ₹90,000.");
    assertGrounded(result);
  }
  const empty = answerFor("dues", { customers: [], customerBills: [], suppliers: [], reminders: [] });
  assert.equal(empty.answer, "No customer owes you anything right now. You owe no supplier anything right now.");
});

test("no dues answer carries a period prefix", () => {
  for (const question of ["dues", "ramesh ka kitna baaki hai", "aaj kisse payment maangna hai", "which customer owes the most"]) {
    assert.doesNotMatch(answerFor(question).answer, /^(Today|Yesterday|This Month):/);
  }
});

test("grounding fails if a printed figure is left out of the fact", () => {
  // The check is only worth something if it can fail. Strip the days-overdue figure out of the fact
  // and the "13 days ago" in the answer must read as invented.
  const result = answerFor("ramesh ka kitna baaki hai");
  const rows = result.rows.map(({ overdue_days: omitted, ...row }) => row);
  const facts = [{ rows, summary: result.summary }];
  assert.equal(assertGroundedAnswer({ answer: result.answer, facts, generated: true }), false);
});

/* ------------------------------------------------------------------------------ reminder linkage */

test("a spoken reminder is linked to one known account when its words point that way", () => {
  const customers = buildCustomerLedger(INPUTS);
  const suppliers = buildSupplierLedger(SUPPLIERS);
  const link = (question) => linkReminderDraft({ question, title: question, customers, suppliers });
  assert.deepEqual(link("kal yaad dilana verma traders ko payment dena hai"), {
    reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "9", linked_entity_name: "Verma Traders",
  });
  assert.deepEqual(link("ramesh se paisa lena hai yaad dilana"), {
    reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "1", linked_entity_name: "Ramesh",
  });
  assert.deepEqual(link("remind me to collect from Suresh"), {
    reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "2", linked_entity_name: "Suresh",
  });
  // A customer spoken of with paying words, two accounts, no account, or no direction: an owner note.
  assert.equal(link("ramesh ko payment dena hai yaad dilana"), null);
  assert.equal(link("verma se paisa lena hai yaad dilana"), null);
  assert.equal(link("ramesh aur verma ka hisab yaad dilana"), null);
  assert.equal(link("naresh se paisa lena hai yaad dilana"), null);
  assert.equal(link("remind me to call ramesh"), null);
  assert.equal(link("remind me to pay my suppliers"), null);
});

/* ------------------------------------------------------------------------------ the routes */

const {
  loadServerApp,
  probe,
  setQueryResponder,
  clearQueryResponder,
} = require("./routeAuthCoverage");
const { issueDeviceSession } = require("./deviceSession");

/** Must match the throwaway key `routeAuthCoverage` pins into the environment before loading. */
const TEST_SIGNING_KEY = "route-auth-coverage-isolated-signing-key-000000";

const OWNER_ROW = {
  rows: [{ id: 7, full_name: "Dhiraj", username: "dhiraj", branch_id: 2, role_name: "Owner", permissions: {} }],
  rowCount: 1,
};

// Dates relative to the server's real day, because the route bounds `date` to within two days of it.
const today = () => new Date().toISOString().slice(0, 10);
const shift = (day, days) => {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
};

/**
 * Two shops. Branch 2 is the caller's; branch 1 is the other shop, with a customer whose name and
 * id sit right beside the caller's so a missing predicate shows up as a stranger in the response.
 */
const branchBooks = (day) => ({
  1: {
    bills: [{ id: 9001, customer_id: 91, customer_name: "Other Shop Debtor", sale_date: shift(day, -30), due_date: shift(day, -20), total_amount: 99999 }],
    credits: [],
    suppliers: [{ supplier_id: 92, supplier_name: "Other Shop Supplier", outstanding_amount: 88888, oldest_purchase_date: shift(day, -9) }],
    reminders: [{ id: 901, reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "92", due_at: `${day}T00:00:00`, status: "OPEN", currently_snoozed: false }],
  },
  2: {
    bills: [
      { id: 101, customer_id: 1, customer_name: "Ramesh", sale_date: shift(day, -20), due_date: shift(day, -13), total_amount: 3000 },
      { id: 102, customer_id: 1, customer_name: "Ramesh", sale_date: shift(day, -20), due_date: shift(day, -13), total_amount: 10000 },
      { id: 201, customer_id: 2, customer_name: "Suresh", sale_date: shift(day, -8), due_date: shift(day, 7), total_amount: 8000 },
    ],
    credits: [{ customer_id: 1, customer_name: "Ramesh", paid_amount: 1000, returned_amount: 0, last_payment_date: shift(day, -8) }],
    suppliers: [
      { supplier_id: 9, supplier_name: "Verma Traders", outstanding_amount: 40000, oldest_purchase_date: shift(day, -21) },
      { supplier_id: 8, supplier_name: "Gupta Fruits", outstanding_amount: 30000, oldest_purchase_date: shift(day, -13) },
    ],
    reminders: [
      { id: 55, reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "2", due_at: `${day}T00:00:00`, status: "OPEN", currently_snoozed: false },
      { id: 57, reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "9", due_at: `${day}T00:00:00`, status: "OPEN", currently_snoozed: false },
    ],
  },
});

const BILLS_SQL = /s\.due_date,\s+s\.total_amount\s+FROM sales s/;
const CREDITS_SQL = /FULL OUTER JOIN returns r/;
const SUPPLIERS_SQL = /SUM\(CASE WHEN COALESCE\(p\.balance_amount, 0\) > 0 THEN p\.balance_amount ELSE 0 END\) AS outstanding_amount/;
const REMINDERS_SQL = /FROM ai_reminders r/;

/**
 * The scripted database. Each ledger statement is answered with the rows of the branch it bound,
 * and only when its predicate reads `branch_id = $1` -- so a statement that lost its predicate, or
 * bound some other number, gets the wrong shop's rows or none and the assertions below see it.
 */
const booksResponder = (day, statements, { failOn = null } = {}) => (sql, values = []) => {
  statements.push({ sql, values });
  if (/FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql)) return OWNER_ROW;
  if (/INSERT INTO ai_conversations/i.test(sql)) return { rows: [{ id: 999 }], rowCount: 1 };
  if (failOn && failOn.test(sql)) throw new Error("connection terminated unexpectedly");
  const books = branchBooks(day)[values[0]];
  const scoped = /branch_id = \$1/.test(sql);
  if (BILLS_SQL.test(sql)) return { rows: scoped && books ? books.bills : [], rowCount: 0 };
  if (CREDITS_SQL.test(sql)) return { rows: scoped && books ? books.credits : [], rowCount: 0 };
  if (SUPPLIERS_SQL.test(sql)) return { rows: scoped && books ? books.suppliers : [], rowCount: 0 };
  if (REMINDERS_SQL.test(sql)) return { rows: scoped && books ? books.reminders : [], rowCount: 0 };
  return { rows: [], rowCount: 0 };
};

let app;
const tokenFor = (branchId) => issueDeviceSession({
  userId: 7,
  deviceId: "FZDEV-PAYMENTS-DUE",
  companyId: 1,
  branchId,
  role: "Owner",
  secret: TEST_SIGNING_KEY,
});

const call = async (method, url, { branchId = 2, body, failOn, day = today() } = {}) => {
  if (!app) app = loadServerApp();
  const statements = [];
  setQueryResponder(booksResponder(day, statements, { failOn }));
  try {
    const headers = { authorization: `Bearer ${tokenFor(branchId)}`, "content-type": "application/json" };
    const response = await probe(app, method, url, headers, body);
    return { response, statements };
  } finally {
    clearQueryResponder();
  }
};

const LEDGER_SQL = [BILLS_SQL, CREDITS_SQL, SUPPLIERS_SQL, REMINDERS_SQL];

test("GET /api/ai/payments-due answers for the caller's branch only", async () => {
  const day = today();
  const { response, statements } = await call("GET", `/api/ai/payments-due?date=${day}`, { day });
  assert.equal(response.status, 200, response.text);
  const body = response.body;
  assert.equal(body.date, day);
  assert.equal(body.action_class, "READ_ONLY");
  assert.deepEqual(body.collect.map((row) => [row.key, row.source, row.overdue_days]), [
    ["customer:1", "BILL", 13],
    ["customer:2", "REMINDER", 0],
  ]);
  assert.equal(body.collect[0].outstanding_amount, 12000);
  assert.deepEqual(body.pay.map((row) => [row.key, row.outstanding_amount, row.reminder_id]), [["supplier:9", 40000, 57]]);
  assert.deepEqual(body.customers.map((row) => row.customer_name), ["Ramesh", "Suresh"]);
  assert.deepEqual(body.suppliers.map((row) => row.supplier_name), ["Verma Traders", "Gupta Fruits"]);
  assert.doesNotMatch(response.text, /Other Shop/, "another branch's accounts must not appear");
  // Every ledger statement ran, and every one bound the session's branch -- never a value from the
  // request, which carried none.
  for (const pattern of LEDGER_SQL) {
    const statement = statements.find(({ sql }) => pattern.test(sql));
    assert.ok(statement, `expected a statement matching ${pattern}`);
    assert.deepEqual(statement.values, [2], `${pattern} must bind the session's branch alone`);
  }
});

test("the branch comes from the session, and a query string cannot move it", async () => {
  const day = today();
  // A branch in the query that disagrees with the session is refused by the auth gate outright;
  // `branchId` is not a field the gate knows, and is simply ignored by the handler.
  const refused = await call("GET", `/api/ai/payments-due?date=${day}&branch_id=1`, { day });
  assert.equal(refused.response.status, 403);
  assert.ok(!refused.statements.some(({ sql }) => LEDGER_SQL.some((pattern) => pattern.test(sql))));
  const { response, statements } = await call("GET", `/api/ai/payments-due?date=${day}&branchId=1`, { day });
  assert.equal(response.status, 200);
  assert.doesNotMatch(response.text, /Other Shop/);
  assert.ok(statements.filter(({ sql }) => LEDGER_SQL.some((pattern) => pattern.test(sql))).every(({ values }) => values[0] === 2));
  // And a session for branch 1 sees branch 1.
  const other = await call("GET", `/api/ai/payments-due?date=${day}`, { branchId: 1, day });
  assert.equal(other.response.status, 200);
  assert.deepEqual(other.response.body.collect.map((row) => row.customer_name), ["Other Shop Debtor"]);
  assert.deepEqual(other.response.body.pay.map((row) => row.supplier_name), ["Other Shop Supplier"]);
});

test("a bad date is a 400 with a code, and the books are not read", async () => {
  const day = today();
  for (const bad of ["2026-02-31", "23-09-2026", "tomorrow", shift(day, 3), shift(day, -3), `${day}&date=${day}`]) {
    const { response, statements } = await call("GET", `/api/ai/payments-due?date=${bad}`);
    assert.equal(response.status, 400, `date=${bad}`);
    assert.equal(response.body.code, "FROST_PAYMENTS_DATE_INVALID");
    assert.ok(!statements.some(({ sql }) => LEDGER_SQL.some((pattern) => pattern.test(sql))), `date=${bad} must not read the books`);
  }
  // Two days either side is the caller's own calendar day in India, and is served.
  for (const near of [shift(day, 2), shift(day, -2)]) {
    const { response } = await call("GET", `/api/ai/payments-due?date=${near}`);
    assert.equal(response.status, 200, `date=${near}`);
    assert.equal(response.body.date, near);
  }
});

test("no date means the server's day", async () => {
  const before = today();
  const { response } = await call("GET", "/api/ai/payments-due");
  const after = today();
  assert.equal(response.status, 200);
  assert.ok([before, after].includes(response.body.date), `date was ${response.body.date}`);
});

test("a failed read is an error, never an empty list", async () => {
  // `collect: []` means "nobody owes you today". A dropped connection must not be able to say that.
  for (const failOn of LEDGER_SQL) {
    const { response } = await call("GET", `/api/ai/payments-due?date=${today()}`, { failOn });
    assert.equal(response.status, 500, `failure in ${failOn}`);
    assert.equal(response.body.code, "FROST_PAYMENTS_DUE_UNAVAILABLE");
    assert.equal(response.body.collect, undefined);
  }
});

test("the payments-due route refuses a caller with no session before reading anything", async () => {
  if (!app) app = loadServerApp();
  const statements = [];
  setQueryResponder((sql) => {
    statements.push(sql);
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(app, "GET", "/api/ai/payments-due", {});
    assert.ok(response.status === 401 || response.status === 403, `expected a refusal, got ${response.status}`);
    assert.ok(!statements.some((sql) => LEDGER_SQL.some((pattern) => pattern.test(sql))));
  } finally {
    clearQueryResponder();
  }
});

test("POST /api/ai/query answers a dues question per account, grounded, with no period prefix", async () => {
  const day = today();
  const { response } = await call("POST", "/api/ai/query", { body: { question: "which customer owes the most" }, day });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.classification, "PAYMENTS");
  assert.equal(response.body.action_class, "READ_ONLY");
  assert.match(response.body.answer, /^Ramesh owes you the most: ₹12,000, unpaid since \d+ \w{3}, due \d+ \w{3}\. Next: Suresh ₹8,000\. In all, 2 customers owe you ₹20,000\.$/);
  const fact = response.body.facts.find((item) => item.type === "payments_due");
  assert.ok(fact, "the payments_due fact must be returned with the answer");
  assert.ok(assertGroundedAnswer({ answer: response.body.answer, facts: response.body.facts, generated: true }));
  assert.doesNotMatch(response.body.answer, /Other Shop/);

  const collect = await call("POST", "/api/ai/query", { body: { question: "aaj kisse payment maangna hai" }, day });
  assert.match(collect.response.body.answer, /^Collect today from 2 customers: Ramesh ₹12,000 \(due \d+ \w{3}, 13 days late\), Suresh ₹8,000 \(reminder for today\)\./);
  assert.ok(assertGroundedAnswer({ answer: collect.response.body.answer, facts: collect.response.body.facts, generated: true }));

  const named = await call("POST", "/api/ai/query", { body: { question: "naresh ka kitna baaki hai" }, day });
  assert.match(named.response.body.answer, /^I could not find Naresh/);
});

test("the streaming twin words a dues question the same way", async () => {
  const day = today();
  const plain = await call("POST", "/api/ai/query", { body: { question: "kis supplier ko sabse zyada dena hai" }, day });
  const streamed = await call("POST", "/api/ai/query/stream", { body: { question: "kis supplier ko sabse zyada dena hai" }, day });
  assert.equal(streamed.response.status, 200);
  const deltas = [...streamed.response.text.matchAll(/event: delta\ndata: (.*)\n/g)].map(([, data]) => JSON.parse(data).text);
  assert.equal(deltas.join(" "), plain.response.body.answer);
  assert.match(plain.response.body.answer, /^You owe Verma Traders the most: ₹40,000/);
});

test("a spoken reminder about one known supplier is drafted as PAY_SUPPLIER, linked to him", async () => {
  const { response } = await call("POST", "/api/ai/query", { body: { question: "kal yaad dilana verma traders ko payment dena hai" } });
  assert.equal(response.status, 200, response.text);
  assert.equal(response.body.classification, "REMINDER_CREATE");
  assert.equal(response.body.action_class, "READ_ONLY");
  const draft = response.body.reminder_draft;
  assert.equal(draft.reminder_type, "PAY_SUPPLIER");
  assert.equal(draft.linked_entity_type, "supplier");
  assert.equal(draft.linked_entity_id, "9");
  assert.equal(draft.linked_entity_name, "Verma Traders");
  assert.ok(draft.title && draft.due_at);

  const collect = await call("POST", "/api/ai/query", { body: { question: "ramesh se paisa lena hai yaad dilana" } });
  assert.equal(collect.response.body.reminder_draft.reminder_type, "COLLECT_PAYMENT");
  assert.equal(collect.response.body.reminder_draft.linked_entity_id, "1");

  // Not certain -> the keys are absent and it stays an owner note.
  const unsure = await call("POST", "/api/ai/query", { body: { question: "remind me to pay my suppliers" } });
  assert.deepEqual(Object.keys(unsure.response.body.reminder_draft).sort(), ["due_at", "title"]);
});

test("the accounts layer reaches nothing outside the process", () => {
  // FROST reads the books and words an answer; it never messages a customer or a supplier. This
  // module is pure, and is held to it: no network, no database, no clock of its own.
  const fs = require("node:fs");
  const code = fs.readFileSync(path.join(__dirname, "frostAccounts.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  for (const forbidden of ["fetch(", "require(\"http", "require(\"https", "require(\"node:http", "graph.facebook", "send-document", "pool.query", "Date.now(", "new Date()"]) {
    assert.ok(!code.includes(forbidden), `frostAccounts.js must not contain ${forbidden}`);
  }
  assert.deepEqual([...code.matchAll(/require\("([^"]+)"\)/g)].map(([, name]) => name), ["./frostAnswer"]);
});
