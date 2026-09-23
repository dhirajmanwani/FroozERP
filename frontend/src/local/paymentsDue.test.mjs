// The laptop is IST. Set before any Date is read, so the local-day tests exercise the real zone
// the shop runs in rather than whatever the CI box happens to be.
process.env.TZ = "Asia/Kolkata";

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  PAYMENTS_DUE_STATUS,
  PAYMENTS_UNREADABLE_KEY,
  attachWhatsappLinks,
  buildPaymentPlan,
  buildPaymentsDuePopup,
  formatRupees,
  isDateKey,
  isPaymentReminder,
  localDateKey,
  nextPaymentsDueMemory,
  paymentReminderRequest,
  paymentsDueBellItems,
  readPaymentsDueMemory,
  reminderDraftLinkFields,
  resolvePaymentReminderRequest,
  shiftDateKey,
} from "./paymentsDue.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const appJsx = readFileSync(join(repoRoot, "frontend/src/App.jsx"), "utf8");

const payload = (overrides = {}) => ({
  date: "2026-09-23",
  collect: [
    {
      key: "customer:004", customer_id: "004", customer_name: "Ramesh", outstanding_amount: 12000,
      due_date: "2026-09-10", overdue_days: 13, source: "BILL", reminder_id: null, settled: false,
    },
    {
      key: "customer:9", customer_id: 9, customer_name: "Suresh", outstanding_amount: 8000.5,
      due_date: "2026-09-23", overdue_days: 0, source: "REMINDER", reminder_id: 41, settled: false,
    },
    {
      key: "customer:12", customer_id: 12, customer_name: "Mahesh", outstanding_amount: 0,
      due_date: "2026-09-20", overdue_days: 3, source: "REMINDER", reminder_id: 42, settled: true,
    },
  ],
  pay: [
    {
      key: "supplier:3", supplier_id: 3, supplier_name: "Verma Traders", outstanding_amount: 40000,
      due_date: "2026-09-23", overdue_days: 0, source: "REMINDER", reminder_id: 77, settled: false,
    },
  ],
  customers: [],
  suppliers: [],
  action_class: "READ_ONLY",
  ...overrides,
});

// --- the local day -------------------------------------------------------------------------------

test("the day is the laptop's local day, not the UTC day, just after IST midnight", () => {
  // 00:30 IST on 24 Sep is still 23 Sep in UTC.
  const justAfterMidnight = new Date("2026-09-23T19:00:00.000Z");
  assert.equal(justAfterMidnight.toISOString().slice(0, 10), "2026-09-23");
  assert.equal(localDateKey(justAfterMidnight), "2026-09-24");
});

test("the day does not roll over early, just before IST midnight", () => {
  const justBeforeMidnight = new Date("2026-09-23T18:29:00.000Z"); // 23:59 IST
  assert.equal(localDateKey(justBeforeMidnight), "2026-09-23");
  // 05:29 IST: UTC still says yesterday, the shop says today.
  assert.equal(localDateKey(new Date("2026-09-23T23:59:00.000Z")), "2026-09-24");
});

test("an unreadable date gives no day rather than a guessed one", () => {
  assert.equal(localDateKey(new Date("nonsense")), "");
  assert.equal(localDateKey("2026-09-23"), "");
  assert.equal(localDateKey(undefined), "");
});

test("tomorrow is calendar arithmetic on the key, across month and year ends", () => {
  assert.equal(shiftDateKey("2026-09-23", 1), "2026-09-24");
  assert.equal(shiftDateKey("2026-09-30", 1), "2026-10-01");
  assert.equal(shiftDateKey("2026-12-31", 1), "2027-01-01");
  assert.equal(shiftDateKey("2028-02-28", 1), "2028-02-29");
  assert.equal(shiftDateKey("2026-02-30", 1), "");
  assert.equal(isDateKey("2026-02-30"), false);
});

// --- money ---------------------------------------------------------------------------------------

test("money is Indian-grouped, whole rupees plain and paise always two digits", () => {
  assert.equal(formatRupees(12000), "₹12,000");
  assert.equal(formatRupees(120000), "₹1,20,000");
  assert.equal(formatRupees(8000.5), "₹8,000.50");
  assert.equal(formatRupees(99.999), "₹100");
  assert.equal(formatRupees(NaN), "");
  assert.equal(formatRupees(null), "");
  assert.equal(formatRupees("abc"), "");
});

// --- the popup -----------------------------------------------------------------------------------

test("the popup says who to collect from and who to pay, in plain English", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), dateKey: "2026-09-23" });
  assert.equal(popup.status, PAYMENTS_DUE_STATUS.OK);
  assert.equal(popup.show, true);
  assert.deepEqual(popup.collectRows.map((row) => row.text), [
    "Collect ₹12,000 from Ramesh (due 10 Sep, 13 days late)",
    "Collect ₹8,000.50 from Suresh (due today)",
  ]);
  assert.deepEqual(popup.payRows.map((row) => row.text), ["Pay Verma Traders ₹40,000 (due today)"]);
  assert.equal(popup.message, "Today: collect from 2 customers and pay 1 supplier.");
  assert.equal(popup.collectTotal, 20000.5);
  assert.equal(popup.payTotal, 40000);
});

test("one day late is singular, and another year's date names its year", () => {
  const popup = buildPaymentsDuePopup({
    payload: payload({
      collect: [{ key: "customer:1", customer_id: 1, customer_name: "A", outstanding_amount: 10, due_date: "2026-09-22", overdue_days: 1 },
        { key: "customer:2", customer_id: 2, customer_name: "B", outstanding_amount: 10, due_date: "2025-12-30" }],
      pay: [],
    }),
    dateKey: "2026-09-23",
  });
  assert.equal(popup.collectRows[0].text, "Collect ₹10 from A (due 22 Sep, 1 day late)");
  // No overdue_days sent: worked out from the two days.
  assert.equal(popup.collectRows[1].text, "Collect ₹10 from B (due 30 Dec 2025, 267 days late)");
});

test("settled rows, and rows whose balance reads as zero, are not shown", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), dateKey: "2026-09-23" });
  assert.ok(!popup.collectRows.some((row) => row.entityName === "Mahesh"));
  const onlySettled = buildPaymentsDuePopup({
    payload: payload({ collect: [payload().collect[2]], pay: [{ ...payload().pay[0], settled: true }] }),
    dateKey: "2026-09-23",
  });
  assert.equal(onlySettled.status, PAYMENTS_DUE_STATUS.OK);
  assert.equal(onlySettled.show, false);
  assert.equal(onlySettled.message, "Nothing to collect or pay today.");
});

test("an unreadable amount is said as unreadable, never as ₹0", () => {
  const popup = buildPaymentsDuePopup({
    payload: payload({ collect: [{ ...payload().collect[0], outstanding_amount: null }], pay: [] }),
    dateKey: "2026-09-23",
  });
  assert.equal(popup.collectRows.length, 1);
  assert.match(popup.collectRows[0].text, /amount could not be read/);
  assert.doesNotMatch(popup.collectRows[0].text, /₹0/);
});

test("a failed load is unreadable, does not open the popup, and never says nothing is due", () => {
  for (const input of [
    { failure: "The server did not answer." },
    { payload: null },
    { payload: { date: "2026-09-23", collect: "x", pay: [] } },
    { payload: { date: "2026-09-23", collect: [] } },
    { payload: payload({ date: "2026-09-22" }) },
  ]) {
    const popup = buildPaymentsDuePopup({ ...input, dateKey: "2026-09-23" });
    assert.equal(popup.status, PAYMENTS_DUE_STATUS.UNREADABLE, JSON.stringify(input));
    assert.equal(popup.show, false);
    assert.deepEqual(popup.collectRows, []);
    assert.doesNotMatch(popup.message, /nothing (to collect|due)/i);
    assert.ok(popup.message.length > 0);
  }
  const failed = buildPaymentsDuePopup({ payload: payload(), failure: "Timed out.", dateKey: "2026-09-23" });
  assert.match(failed.message, /could not be read/);
  assert.match(failed.message, /Timed out\./);
});

test("the failure wins even when an old list is still in hand", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), failure: "Offline.", dateKey: "2026-09-23" });
  assert.equal(popup.status, PAYMENTS_DUE_STATUS.UNREADABLE);
  assert.equal(popup.show, false);
});

test("no readable today means no popup", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), dateKey: "" });
  assert.equal(popup.status, PAYMENTS_DUE_STATUS.UNREADABLE);
  assert.equal(popup.show, false);
});

test("closing the popup keeps it closed for that day only", () => {
  const today = buildPaymentsDuePopup({ payload: payload(), dateKey: "2026-09-23", dismissedDateKey: "2026-09-23" });
  assert.equal(today.status, PAYMENTS_DUE_STATUS.OK);
  assert.equal(today.show, false);
  assert.equal(today.collectRows.length, 2, "the rows are still there for the bell and a reopen");
  const tomorrow = buildPaymentsDuePopup({ payload: payload({ date: "2026-09-24" }), dateKey: "2026-09-24", dismissedDateKey: "2026-09-23" });
  assert.equal(tomorrow.show, true);
});

test("a row dealt with today is hidden today", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), dateKey: "2026-09-23", hiddenKeys: ["customer:004", "supplier:3"] });
  assert.deepEqual(popup.collectRows.map((row) => row.key), ["customer:9"]);
  assert.deepEqual(popup.payRows, []);
});

test("the day's memory survives a reload and is forgotten the next day", () => {
  let memory = readPaymentsDueMemory(null, "2026-09-23");
  assert.deepEqual(memory, { date: "2026-09-23", dismissed: false, hiddenKeys: [] });
  memory = nextPaymentsDueMemory(memory, "2026-09-23", { hideKey: "customer:004" });
  memory = nextPaymentsDueMemory(memory, "2026-09-23", { dismiss: true });
  const stored = JSON.stringify(memory);
  assert.deepEqual(readPaymentsDueMemory(stored, "2026-09-23"), { date: "2026-09-23", dismissed: true, hiddenKeys: ["customer:004"] });
  assert.deepEqual(readPaymentsDueMemory(stored, "2026-09-24"), { date: "2026-09-24", dismissed: false, hiddenKeys: [] });
  assert.deepEqual(readPaymentsDueMemory("{not json", "2026-09-23").hiddenKeys, []);
});

test("ids stay strings: 004 is not 4", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), dateKey: "2026-09-23" });
  assert.equal(popup.collectRows[0].entityId, "004");
  assert.equal(popup.collectRows[1].reminderId, "41");
  const request = paymentReminderRequest({ kind: "collect", entityId: "004", entityName: "Ramesh", amount: 12000, dueDate: "2026-09-24" });
  assert.equal(request.body.linked_entity_id, "004");
  assert.equal(typeof request.body.linked_entity_id, "string");
});

// --- the reminder request ------------------------------------------------------------------------

test("no reminder yet: POST a linked COLLECT_PAYMENT reminder", () => {
  const request = paymentReminderRequest({ kind: "collect", entityId: 7, entityName: "Ramesh", amount: 12000, dueDate: "2026-09-24" });
  assert.deepEqual(request, {
    method: "POST",
    path: "/api/ai/reminders",
    body: {
      reminder_type: "COLLECT_PAYMENT",
      priority: "ATTENTION",
      linked_entity_type: "customer",
      linked_entity_id: "7",
      due_at: "2026-09-24",
      title: "Collect payment from Ramesh",
      message: "Collect ₹12,000 from Ramesh.",
    },
  });
});

test("no reminder yet for a supplier: POST a linked PAY_SUPPLIER reminder", () => {
  const request = paymentReminderRequest({ kind: "pay", entityId: "3", entityName: "Verma Traders", amount: 40000, dueDate: "2026-09-25" });
  assert.equal(request.method, "POST");
  assert.equal(request.body.reminder_type, "PAY_SUPPLIER");
  assert.equal(request.body.linked_entity_type, "supplier");
  assert.equal(request.body.title, "Pay Verma Traders");
  assert.equal(request.body.message, "Pay Verma Traders ₹40,000.");
});

test("a reminder already exists: PATCH its date instead of making a second one", () => {
  const request = paymentReminderRequest({ kind: "collect", entityId: "004", entityName: "Ramesh", amount: 12000, dueDate: "2026-09-24", existingReminderId: 41 });
  assert.deepEqual(request, { method: "PATCH", path: "/api/ai/reminders/41", body: { action: "SET_DUE_DATE", due_at: "2026-09-24" } });
});

test("clearing the date takes the reminder away; with nothing to clear, nothing is sent", () => {
  assert.deepEqual(
    paymentReminderRequest({ kind: "pay", entityId: "3", dueDate: "", existingReminderId: "77" }),
    { method: "PATCH", path: "/api/ai/reminders/77", body: { action: "RESOLVE" } },
  );
  assert.equal(paymentReminderRequest({ kind: "pay", entityId: "3", dueDate: "" }), null);
});

test("Done resolves the reminder when there is one, and sends nothing for a bill-only row", () => {
  assert.deepEqual(resolvePaymentReminderRequest("041"), { method: "PATCH", path: "/api/ai/reminders/041", body: { action: "RESOLVE" } });
  assert.equal(resolvePaymentReminderRequest(null), null);
  assert.equal(resolvePaymentReminderRequest(""), null);
});

test("a bad kind, a missing account or an impossible date is refused, not guessed", () => {
  assert.throws(() => paymentReminderRequest({ kind: "send", entityId: "3", dueDate: "2026-09-24" }));
  assert.throws(() => paymentReminderRequest({ kind: "collect", entityId: "", dueDate: "2026-09-24" }));
  assert.throws(() => paymentReminderRequest({ kind: "collect", entityId: "3", dueDate: "2026-02-30" }));
});

test("a FROST reminder draft passes its link through only as a consistent set", () => {
  assert.deepEqual(
    reminderDraftLinkFields({ reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "004" }),
    { reminder_type: "PAY_SUPPLIER", linked_entity_type: "supplier", linked_entity_id: "004" },
  );
  assert.deepEqual(
    reminderDraftLinkFields({ reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: 12 }),
    { reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer", linked_entity_id: "12" },
  );
  assert.deepEqual(reminderDraftLinkFields({ title: "call the plumber" }), { reminder_type: "OWNER_NOTE" });
  assert.deepEqual(reminderDraftLinkFields({ reminder_type: "PAY_SUPPLIER", linked_entity_type: "customer", linked_entity_id: "1" }), { reminder_type: "OWNER_NOTE" });
  assert.deepEqual(reminderDraftLinkFields({ reminder_type: "COLLECT_PAYMENT", linked_entity_type: "customer" }), { reminder_type: "OWNER_NOTE" });
});

// --- the bell ------------------------------------------------------------------------------------

test("bell rows are today's unsettled items, keyed by row and day", () => {
  const bell = paymentsDueBellItems(payload(), "2026-09-23", { nowMs: Date.parse("2026-09-23T04:00:00Z") });
  assert.equal(bell.status, PAYMENTS_DUE_STATUS.OK);
  assert.deepEqual(bell.keys, [
    "payment:customer:004:2026-09-23",
    "payment:customer:9:2026-09-23",
    "payment:supplier:3:2026-09-23",
  ]);
  const [first] = bell.items;
  assert.equal(first.dedupeKey, first.id);
  assert.equal(first.title, "Collect from Ramesh");
  assert.equal(first.message, "Collect ₹12,000 from Ramesh (due 10 Sep, 13 days late).");
  assert.equal(bell.items[2].title, "Pay Verma Traders");
  assert.equal(first.at, "2026-09-23T04:00:00.000Z");
  for (const field of ["severity", "message", "source", "sticky"]) assert.ok(field in first, field);
  // Two polls of the same list claim the same keys, so nothing is raised twice.
  assert.deepEqual(paymentsDueBellItems(payload(), "2026-09-23").keys, bell.keys);
});

test("a failed read rings one sticky error row and claims no row keys", () => {
  const bell = paymentsDueBellItems(payload(), "2026-09-23", { failure: "Timed out." });
  assert.equal(bell.status, PAYMENTS_DUE_STATUS.UNREADABLE);
  assert.deepEqual(bell.keys, [PAYMENTS_UNREADABLE_KEY]);
  assert.equal(bell.items[0].sticky, true);
  assert.match(bell.items[0].title, /could not be read/);
});

test("payment reminders are recognised so the FROST reminder rows do not ring them twice", () => {
  assert.equal(isPaymentReminder({ reminder_type: "COLLECT_PAYMENT" }), true);
  assert.equal(isPaymentReminder({ reminder_type: "pay_supplier" }), true);
  assert.equal(isPaymentReminder({ reminder_type: "OWNER_NOTE" }), false);
  assert.equal(isPaymentReminder(null), false);
});

// --- WhatsApp and the panel ----------------------------------------------------------------------

test("only a customer the outreach list can send to gets a WhatsApp link, joined by exact id", () => {
  const popup = buildPaymentsDuePopup({ payload: payload(), dateKey: "2026-09-23" });
  const outreach = {
    status: "ok",
    rows: [
      { customer_id: "4", action: "SEND", link: "https://wa.me/919800000004?text=wrong" },
      { customer_id: "004", action: "SEND", link: "https://wa.me/919800000000?text=hi" },
      { customer_id: 9, action: "OPTED_OUT", link: "" },
    ],
  };
  const rows = attachWhatsappLinks(popup.collectRows, outreach, "SEND");
  assert.equal(rows[0].whatsappLink, "https://wa.me/919800000000?text=hi", "004 must not match 4");
  assert.equal(rows[1].whatsappLink, "");
  assert.deepEqual(attachWhatsappLinks(popup.collectRows, { status: "unreadable", rows: [] }).map((row) => row.whatsappLink), ["", ""]);
});

test("the panel's payment dates are keyed by exact id, and a failure is not empty date boxes", () => {
  const plan = buildPaymentPlan({
    payload: payload({
      customers: [{ customer_id: "004", customer_name: "Ramesh", outstanding_amount: 12000, next_due_date: "2026-09-10", payment_reminder: { id: 41, due_at: "2026-09-25T00:00:00" } }],
      suppliers: [{ supplier_id: 3, supplier_name: "Verma Traders", outstanding_amount: 40000, oldest_purchase_date: "2026-08-01", payment_reminder: null }],
    }),
  });
  assert.equal(plan.status, PAYMENTS_DUE_STATUS.OK);
  assert.deepEqual(plan.customersById.get("004").reminder, { id: "41", dueAt: "2026-09-25" });
  assert.equal(plan.customersById.get("4"), undefined);
  assert.equal(plan.suppliers[0].amountText, "₹40,000");
  assert.equal(plan.suppliers[0].reminder, null);

  const failed = buildPaymentPlan({ payload: null, failure: "Offline." });
  assert.equal(failed.status, PAYMENTS_DUE_STATUS.UNREADABLE);
  assert.match(failed.message, /could not be read/);
  assert.equal(buildPaymentPlan({ payload: { customers: [] } }).status, PAYMENTS_DUE_STATUS.UNREADABLE);
});

// --- App.jsx wiring (source text, in the style of frostBellWiring.test.mjs) ----------------------

const slice = (startMarker, endMarker) => {
  const start = appJsx.indexOf(startMarker);
  assert.notEqual(start, -1, `App.jsx no longer contains ${startMarker}`);
  const end = appJsx.indexOf(endMarker, start);
  assert.notEqual(end, -1, `could not find the end of ${startMarker}`);
  return appJsx.slice(start, end);
};

const paymentsLoader = () => slice("const loadPaymentsDue = useCallback", "deviceInfo?.device_id]);");

test("the payments list is loaded with the local day, under the bell's own gate", () => {
  const body = paymentsLoader();
  assert.match(body, /if \(!user \|\| !frostBellAllowed\) return;/);
  assert.match(body, /resolveFrostLoadDecision\(/);
  assert.match(body, /shouldLoad[\s\S]*skipped: true/, "LOCAL_ONLY / offline must be a skip, not a failure");
  assert.match(body, /\/api\/ai\/payments-due/);
  assert.match(body, /const dateKey = localDateKey\(new Date\(\)\);/, "the date sent must be the device's local day");
  assert.match(body, /params: \{[^}]*date: dateKey/, "the local day must be the one sent");
  assert.ok(!body.includes("toISOString"), "the UTC day must never be sent as today");
  assert.match(body, /catch \(error\)[\s\S]*error: getFrostDiagnosticMessage\(error/);
  assert.ok(!body.includes("frostDrawerOpen"), "the popup must not wait for the FROST panel to be opened");
  assert.notEqual(appJsx.indexOf("loadPaymentsDue(); }, 300000)"), -1, "the payments list no longer refreshes on the bell's timer");
});

test("a LOCAL_ONLY skip returns before any request is made", () => {
  const body = paymentsLoader();
  const skip = body.indexOf("if (!loadDecision.shouldLoad)");
  const request = body.indexOf("axios.get(");
  assert.ok(skip !== -1 && request !== -1 && skip < request, "the payments request must sit behind the load decision");
});

test("the popup is built by the tested module and only opens on its show flag", () => {
  assert.match(appJsx, /buildPaymentsDuePopup\(\{/);
  assert.match(appJsx, /\{paymentsPopup\.show && \(/, "the popup must render only when the module says show");
  assert.ok(!/paymentsPopup\.(collectRows|payRows)\.length\s*>\s*0\s*&&\s*\(/.test(appJsx),
    "the popup must not open by counting rows, which is how a failure would open as an empty list");
});

test("payment bell rows are retracted only after a successful read", () => {
  const body = slice("const raisedPaymentBellRows", "[paymentsDue, frostBellAllowed, notify, clearNotice]");
  const guard = body.indexOf("PAYMENTS_DUE_STATUS.OK");
  assert.notEqual(guard, -1);
  const permissionExit = body.indexOf("if (!frostBellAllowed)");
  const permissionExitEnd = body.indexOf("if (!paymentsDue.read)");
  assert.ok(permissionExit !== -1 && permissionExitEnd !== -1);
  let at = body.indexOf("clearNotice(");
  let found = 0;
  while (at !== -1) {
    assert.ok((at > permissionExit && at < permissionExitEnd) || at > guard,
      "a payment bell row is retracted before the successful-read guard");
    found += 1;
    at = body.indexOf("clearNotice(", at + 1);
  }
  assert.ok(found >= 2);
  assert.match(body, /raised\.get\(item\.dedupeKey\) === item\.message/, "unchanged rows must not be raised again");
});

test("the FROST bell does not ring payment reminders a second time", () => {
  const start = appJsx.indexOf("const raisedFrostBellRows");
  const body = appJsx.slice(start, appJsx.indexOf("frostBellAllowed, notify, clearNotice]", start));
  assert.match(body, /reminders: \(frostBell\.reminders \|\| \[\]\)\.filter\(\(row\) => !isPaymentReminder\(row\)\)/);
});

test("nothing in the popup sends a message by itself", () => {
  const body = slice("function PaymentsDuePopup", "\n}\n");
  assert.ok(!body.includes("send-document"), "the popup must never post to the WhatsApp send route");
  assert.ok(!/send all/i.test(body), "no bulk send");
  assert.match(body, /whatsappLink/);
});

test("a FROST reminder draft's link is passed through the tested helper", () => {
  const body = slice("const draft = response.data.reminder_draft;", "} catch (reminderError)");
  assert.match(body, /\.\.\.reminderDraftLinkFields\(draft\)/);
  assert.ok(!body.includes('reminder_type: "OWNER_NOTE"'), "the reminder type must come from the draft, not be hard-coded");
});
