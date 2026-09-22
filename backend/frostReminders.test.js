"use strict";

/**
 * Two halves of one request the owner made in one sentence: that reminders carry a due date he
 * typed, and that customers who owe him money arrive with something he can actually send.
 *
 * ## What each half was before
 *
 * `isReminderRequest` got the reminder created and `reminderTitleFrom` put his own words in it, and
 * nothing read *when*. Every reminder he asked for therefore landed with `due_at` null, and
 * `getReminders` orders on `due_at NULLS LAST` -- so the reminders he asked for out loud sorted
 * below every dated one and were never surfaced on the day they mattered. A feature that files
 * things correctly and never shows them is indistinguishable from one that lost them.
 *
 * The dues half existed as an alert (`CUSTOMER_PAYMENT_OVERDUE`) that says who is late and nothing
 * about what to do next. The owner asked for FROST to either message those customers or remind him
 * about them; this is the reminding, and **the messaging is deliberately not built**. The last test
 * in this file is the one that matters most: it asserts that nothing on this path can reach
 * `POST /api/whatsapp/send-document`, which spends the shop's live WhatsApp Cloud credentials
 * against real customers' numbers.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  detectReminderDueDate,
  detectSpokenRange,
  reminderDueDateRuleWords,
  REMINDER_DUE_DATE_RULES,
} = require("./frostLanguage");
const {
  CONTACT_STATUS,
  buildCustomerReminderMessage,
  contactStatusFor,
  normalizeReminderDueAt,
  prepareCustomerDueReminder,
} = require("./frostReminders");
const { assertGroundedAnswer } = require("./aiBusinessAssistantRules");
const { getCustomerDueReminders, OVERDUE_DUE_STATUSES } = require("./aiBusinessAssistantService");

/* ------------------------------------------------------------------ the due date he types */

/** A Tuesday, and mid-afternoon on purpose: a parser reading a clock would betray itself here. */
const TUESDAY = new Date("2026-09-22T14:45:00.000Z");

test("a reminder with no date in it gets no date, rather than today", () => {
  // Defaulting to today is the tempting bug and the expensive one: a reminder silently dated today
  // fires once, today, and is gone, while an undated one is still sitting there for him to date.
  assert.equal(detectReminderDueDate("remind me to pay my suppliers", TUESDAY), "");
  assert.equal(detectReminderDueDate("yaad dilana mandi jana hai", TUESDAY), "");
  assert.equal(detectReminderDueDate("", TUESDAY), "");
});

test("kal is tomorrow in a reminder, and still yesterday in a question about the books", () => {
  // The one word this whole feature turns on. `detectSpokenRange` reads a question about figures,
  // which can only concern days that have happened; a reminder is a thing to be done, which can
  // only be ahead. Same word, opposite reading, and reading it wrong here dates every spoken
  // reminder to a day that has already passed -- where it can never fire.
  assert.equal(detectReminderDueDate("kal yaad dilana", TUESDAY), "2026-09-23");
  assert.equal(detectReminderDueDate("remind me tomorrow to call ravi", TUESDAY), "2026-09-23");
  assert.equal(detectSpokenRange("kal kitna bika"), "yesterday");
});

test("today is today", () => {
  assert.equal(detectReminderDueDate("aaj yaad dilana", TUESDAY), "2026-09-22");
  assert.equal(detectReminderDueDate("remind me today to check old lots", TUESDAY), "2026-09-22");
});

test("parso is the day after tomorrow", () => {
  assert.equal(detectReminderDueDate("parso yaad dilana", TUESDAY), "2026-09-24");
  assert.equal(detectReminderDueDate("remind me day after tomorrow", TUESDAY), "2026-09-24");
});

test("a counted span of days is counted forward", () => {
  // "3 din" with no "baad" on the end is how he writes it half the time, and inside a reminder a
  // bare count can only mean ahead: nobody asks to be reminded three days ago.
  assert.equal(detectReminderDueDate("3 din baad yaad dilana", TUESDAY), "2026-09-25");
  assert.equal(detectReminderDueDate("remind me in 3 days", TUESDAY), "2026-09-25");
  assert.equal(detectReminderDueDate("10 dino me yaad dilana", TUESDAY), "2026-10-02");
});

test("a week is seven days, however he says it", () => {
  assert.equal(detectReminderDueDate("remind me next week", TUESDAY), "2026-09-29");
  assert.equal(detectReminderDueDate("agle hafte yaad dilana", TUESDAY), "2026-09-29");
  assert.equal(detectReminderDueDate("hafte baad yaad dilana", TUESDAY), "2026-09-29");
  assert.equal(detectReminderDueDate("2 hafte baad yaad dilana", TUESDAY), "2026-10-06");
});

test("a counted span beats the bare word it contains", () => {
  // "2 hafte" read as the word "hafte" alone is one week instead of two -- a silent substitution of
  // one date for another, which is the failure this whole module was written against.
  assert.notEqual(
    detectReminderDueDate("2 hafte baad yaad dilana", TUESDAY),
    detectReminderDueDate("hafte baad yaad dilana", TUESDAY),
  );
});

test("a weekday means the next one, never the one being lived through", () => {
  // The reference is a Tuesday. "mangalvar ko yaad dilana" said on a Tuesday means the Tuesday
  // coming: a reminder for a day already half gone is not what he asked for.
  assert.equal(detectReminderDueDate("friday ko yaad dilana", TUESDAY), "2026-09-25");
  assert.equal(detectReminderDueDate("somvar ko yaad dilana", TUESDAY), "2026-09-28");
  assert.equal(detectReminderDueDate("mangalvar ko yaad dilana", TUESDAY), "2026-09-29");
});

test("a date of the month resolves to the next month that actually has it", () => {
  assert.equal(detectReminderDueDate("25 tarikh ko yaad dilana", TUESDAY), "2026-09-25");
  // The 15th has passed this month, so he means next month's. Answering with a date behind him is
  // a reminder that can never fire.
  assert.equal(detectReminderDueDate("15 tarikh ko yaad dilana", TUESDAY), "2026-10-15");
  assert.equal(detectReminderDueDate("remind me on the 5th", TUESDAY), "2026-10-05");
  assert.equal(detectReminderDueDate("5 ko yaad dilana", TUESDAY), "2026-10-05");
});

test("a day the month does not have is never rolled over into the next one", () => {
  // `new Date(Date.UTC(2026, 8, 31))` is the 1st of October, silently. "31 tarikh" asked in
  // September has to land on a real 31st, not on a date the owner did not name.
  assert.equal(detectReminderDueDate("31 tarikh ko yaad dilana", TUESDAY), "2026-10-31");
  // And a day no month has produces no date at all rather than a guess.
  assert.equal(detectReminderDueDate("32 tarikh ko yaad dilana", TUESDAY), "");
});

test("an amount is not read as a date", () => {
  // "2000 ko" is a rupee figure with a postposition, not the 20th. A two-digit cap plus the word
  // boundary in front is what keeps the tail of an amount out of `due_at`.
  assert.equal(detectReminderDueDate("remind me to collect 2000 ko ravi se", TUESDAY), "");
});

test("the reference moment decides the answer, and the parser never reads a clock", () => {
  // The rule the whole signature exists for. A parser that called `new Date()` inside itself is
  // untestable except by mocking time, and two calls a millisecond apart across midnight disagree.
  const wednesday = new Date("2026-09-23T03:00:00.000Z");
  assert.equal(detectReminderDueDate("kal yaad dilana", TUESDAY), "2026-09-23");
  assert.equal(detectReminderDueDate("kal yaad dilana", wednesday), "2026-09-24");
  // Same reference, same answer, regardless of time of day within that day.
  assert.equal(
    detectReminderDueDate("kal yaad dilana", new Date("2026-09-22T00:00:00.000Z")),
    detectReminderDueDate("kal yaad dilana", new Date("2026-09-22T23:59:59.000Z")),
  );
});

test("a caller that names no reference moment is refused rather than served the clock", () => {
  // Loud, for the same reason `requireBranchScope` throws: a quietly-substituted default is the
  // failure class this codebase keeps paying for. Every rule here is relative to something.
  assert.throws(() => detectReminderDueDate("kal yaad dilana"), /FROST_REMINDER_REFERENCE_DATE_REQUIRED/);
  assert.throws(() => detectReminderDueDate("kal yaad dilana", "not a date"), /FROST_REMINDER_REFERENCE_DATE_REQUIRED/);
});

test("no due-date pattern is written with a boundary it cannot match", () => {
  // `/\b(pichl)\b/` never matches "pichle": the boundary after the l wants a non-word character and
  // an e follows. Two patterns have already shipped in `frostLanguage.js` with this bug and matched
  // nothing at all, so every spelling written into these rules is checked against the rule that
  // claims to know it.
  const words = reminderDueDateRuleWords();
  assert.ok(words.length > 20, "the rules should contribute a real vocabulary to check");
  // A spelling is checked in the shapes it is actually written in: some of these words only ever
  // appear next to a count ("7 din") or next to the unit they modify ("next week"), and testing
  // them bare would fail for a reason that is not the bug being hunted.
  const carriers = (word) => [word, `7 ${word}`, `${word} week`, `${word} after tomorrow`, `hafte ${word}`];
  for (const word of words) {
    const matched = REMINDER_DUE_DATE_RULES.some((rule) => carriers(word).some((phrase) => rule.pattern.test(phrase)));
    assert.ok(matched, `no rule can match its own spelling "${word}"`);
  }
});

/* ------------------------------------------------------- the message he reviews before sending */

/** One row as `getCustomerOutstanding` produces it, plus the contact columns the dues query adds. */
const ROW = Object.freeze({
  customer_id: 4,
  customer_name: "Ravi Traders",
  outstanding_amount: 12500.5,
  oldest_invoice_date: "2026-08-01",
  oldest_due_date: "2026-08-15",
  last_payment_date: "2026-08-20",
  overdue_days: 38,
  due_status: "SERIOUSLY_OVERDUE",
  risk_classification: "HIGH",
  whatsapp_number: "919812345678",
  mobile_number: "9812345678",
  whatsapp_opt_in: true,
});

const SHOP = "Feel The Freakin Frooz";
const maskNumber = (value) => {
  const text = String(value || "").trim();
  if (text.length < 4) return "";
  return `${"*".repeat(Math.max(0, text.length - 4))}${text.slice(-4)}`;
};

test("the message names the amount exactly as the ledger carries it", () => {
  // Not rounded to a nicer number. 12500.50 sent as "12,500" is the shop asking for the wrong sum
  // under its own name, to somebody who has no way of knowing it is wrong.
  const message = buildCustomerReminderMessage({
    customerName: ROW.customer_name, shopName: SHOP, outstandingAmount: ROW.outstanding_amount,
  });
  assert.match(message, /12,500\.50/);
  assert.match(message, /Ravi Traders/);
  assert.match(message, new RegExp(SHOP));
});

test("the message contains no figure that is not in the source row", () => {
  // The rule FROST is built on, applied where it matters most. An invented figure in an *answer*
  // misleads the owner, who knows his books; an invented figure in a *message* goes out under the
  // shop's name to a customer, who does not.
  const message = buildCustomerReminderMessage({
    customerName: ROW.customer_name, shopName: SHOP, outstandingAmount: ROW.outstanding_amount,
  });
  assert.ok(
    assertGroundedAnswer({ answer: message, facts: [ROW], allowedText: `${ROW.customer_name} ${SHOP}` }),
    `the draft states a figure the row does not: ${message}`,
  );
});

test("the overdue day count and the due date stay out of the customer's message", () => {
  // They are on the row for the owner's own screen. "38 days overdue" in the message reads as a
  // count being kept, and every extra figure is one more thing that can be wrong in something sent
  // under the shop's name.
  const message = buildCustomerReminderMessage({
    customerName: ROW.customer_name, shopName: SHOP, outstandingAmount: ROW.outstanding_amount,
  });
  assert.doesNotMatch(message, /38/);
  assert.doesNotMatch(message, /2026/);
});

test("the message threatens nobody", () => {
  // A fruit shop's credit customers are neighbours who come back next week. A demand letter costs
  // more than the balance it chases, and FROST must never be the thing that sent one.
  const message = buildCustomerReminderMessage({
    customerName: ROW.customer_name, shopName: SHOP, outstandingAmount: ROW.outstanding_amount,
  }).toLowerCase();
  for (const word of ["legal", "penalty", "late fee", "interest", "immediately", "failing", "action", "warning", "final"]) {
    assert.ok(!message.includes(word), `the draft should not say "${word}"`);
  }
});

test("the shop names itself", () => {
  // A payment message from an unnamed number is the shape of every scam the customer has been
  // warned about, so an unreadable shop name produces a plain phrase rather than a blank.
  assert.match(buildCustomerReminderMessage({ customerName: "Sita", shopName: "", outstandingAmount: 500 }), /aapki dukaan se/);
});

test("no message is drafted for a balance that is not owed", () => {
  // A draft saying a customer owes zero is worse than no draft: it is a wrong statement about their
  // account, ready to send.
  assert.equal(buildCustomerReminderMessage({ customerName: "Sita", shopName: SHOP, outstandingAmount: 0 }), "");
  assert.equal(buildCustomerReminderMessage({ customerName: "Sita", shopName: SHOP, outstandingAmount: -10 }), "");
  assert.equal(buildCustomerReminderMessage({ customerName: "Sita", shopName: SHOP }), "");
});

test("a customer who cannot be messaged is named as such, not left out", () => {
  // "No number on file" disappearing from the list makes it look like nothing is owed. An absent
  // thing that should be there must never render as an empty one.
  assert.equal(contactStatusFor({ whatsappNumber: "", mobileNumber: "" }), CONTACT_STATUS.NO_NUMBER);
  assert.equal(contactStatusFor({ whatsappNumber: "919812345678", whatsappOptIn: false }), CONTACT_STATUS.OPTED_OUT);
  assert.equal(contactStatusFor({ whatsappNumber: "919812345678", whatsappOptIn: true }), CONTACT_STATUS.READY);
});

test("a customer never asked about opting out has not opted out", () => {
  // The column defaults to true and is null on every row written before it existed. Reading null as
  // a refusal would silently hide most of the ledger behind "opted out".
  assert.equal(contactStatusFor({ mobileNumber: "9812345678", whatsappOptIn: null }), CONTACT_STATUS.READY);
  assert.equal(contactStatusFor({ mobileNumber: "9812345678", whatsappOptIn: undefined }), CONTACT_STATUS.READY);
});

test("a prepared row carries a draft even when nobody can send it", () => {
  const prepared = prepareCustomerDueReminder(
    { ...ROW, whatsapp_number: "", mobile_number: "", whatsapp_opt_in: true },
    { shopName: SHOP, maskNumber },
  );
  assert.equal(prepared.contact_status, CONTACT_STATUS.NO_NUMBER);
  assert.equal(prepared.has_whatsapp_number, false);
  assert.ok(prepared.prepared_message.length > 0, "he can still read it out on the phone");
});

test("a masked number and a missing number are told apart", () => {
  // `maskPhone` answers "" for anything shorter than four digits, so the masked string alone cannot
  // say whether a number exists. Without the booleans, "no number on file" and "masked to nothing"
  // are the same value on the wire.
  const withNumber = prepareCustomerDueReminder({ ...ROW, whatsapp_number: "12" }, { shopName: SHOP, maskNumber });
  const without = prepareCustomerDueReminder({ ...ROW, whatsapp_number: "" }, { shopName: SHOP, maskNumber });
  assert.equal(withNumber.whatsapp_number_masked, "");
  assert.equal(without.whatsapp_number_masked, "");
  assert.equal(withNumber.has_whatsapp_number, true);
  assert.equal(without.has_whatsapp_number, false);
});

/* ------------------------------------------------------------------- the route, against a stub */

/**
 * A pool that answers the four statements the dues panel runs and records every one of them.
 *
 * Recorded rather than asserted inline, because the thing under test is as much *which statements
 * ran and what they bound* as it is the payload: a branch predicate is only a branch predicate when
 * the session's branch is what got bound to it.
 */
const stubPool = ({ outstanding = [], contacts = [], businessName = SHOP } = {}) => {
  const statements = [];
  return {
    statements,
    query: async (text, values = []) => {
      statements.push({ text, values });
      if (/WITH credit_sales/.test(text)) return { rows: outstanding, rowCount: outstanding.length };
      if (/FROM customers c/.test(text)) return { rows: contacts, rowCount: contacts.length };
      if (/FROM business_settings/.test(text)) return { rows: [{ business_name: businessName }], rowCount: 1 };
      return { rows: [], rowCount: 0 };
    },
  };
};

/** The ledger row as the SQL returns it, before `getCustomerOutstanding` classifies it. */
const LEDGER_ROWS = [
  {
    customer_id: 4,
    customer_name: "Ravi Traders",
    mobile_number: "9812345678",
    oldest_invoice_date: "2026-08-01",
    oldest_due_date: "2026-08-15",
    last_payment_date: "2026-08-20",
    outstanding_amount: 12500.5,
  },
  {
    customer_id: 9,
    customer_name: "Sita Fruits",
    mobile_number: null,
    oldest_invoice_date: "2026-09-18",
    oldest_due_date: "2026-12-31",
    last_payment_date: null,
    outstanding_amount: 800,
  },
];

const CONTACT_ROWS = [
  { customer_id: 4, whatsapp_number: "919812345678", mobile_number: "9812345678", whatsapp_opt_in: true },
  { customer_id: 9, whatsapp_number: "919800000000", mobile_number: null, whatsapp_opt_in: false },
];

const SETTINGS = { thresholds: { dueSoonDays: 3, seriousOverdueDays: 21, criticalOverdueDays: 45, criticalOutstandingAmount: 100000, highOutstandingAmount: 50000 } };

test("the branch bound is the branch asked for, on both reads of business data", async () => {
  const pool = stubPool({ outstanding: LEDGER_ROWS, contacts: CONTACT_ROWS });
  await getCustomerDueReminders(pool, 2, SETTINGS);
  const tenantStatements = pool.statements.filter(({ text }) => /\bFROM\s+(?:sales|customers)\b/i.test(text));
  assert.ok(tenantStatements.length >= 2, "both the ledger and the contact read must be measured");
  for (const { text, values } of tenantStatements) {
    const predicate = text.match(/branch_id = \$(\d+)/);
    assert.ok(predicate, `a statement against tenant data carries no branch predicate: ${text}`);
    assert.equal(values[Number(predicate[1]) - 1], 2, "and must bind the branch it was asked for");
  }
});

test("a call with no branch is refused rather than widened to every shop", async () => {
  // An absent scope rendering as "all scopes" is the disclosure `requireBranchScope` exists to stop,
  // and a dues list is every customer's name, balance and contact state at once.
  await assert.rejects(
    () => getCustomerDueReminders(stubPool(), undefined, SETTINGS),
    /FROST_BRANCH_SCOPE_REQUIRED/,
  );
});

test("each customer who owes money arrives with a draft and an honest contact state", async () => {
  const dues = await getCustomerDueReminders(
    stubPool({ outstanding: LEDGER_ROWS, contacts: CONTACT_ROWS }),
    2,
    SETTINGS,
  );
  const [ravi, sita] = dues.customers;
  assert.equal(ravi.customer_name, "Ravi Traders");
  assert.match(ravi.prepared_message, /12,500\.50/);
  assert.equal(ravi.contact_status, CONTACT_STATUS.READY);
  // Sita's number is on file and she has opted out. The draft still exists; the panel has to say
  // why it must not go.
  assert.equal(sita.contact_status, CONTACT_STATUS.OPTED_OUT);
  assert.equal(sita.whatsapp_opt_in, false);
  assert.ok(sita.prepared_message.length > 0);
});

test("no prepared message states a figure its own row does not", async () => {
  // Walked over the real assembled payload rather than over a hand-built row, because the figure in
  // the message and the figure on the row are produced by two different code paths and the whole
  // risk is that they drift.
  const dues = await getCustomerDueReminders(
    stubPool({ outstanding: LEDGER_ROWS, contacts: CONTACT_ROWS }),
    2,
    SETTINGS,
  );
  for (const customer of dues.customers) {
    assert.ok(
      assertGroundedAnswer({
        answer: customer.prepared_message,
        facts: [customer],
        allowedText: `${customer.customer_name} ${dues.shop_name}`,
      }),
      `${customer.customer_name}'s draft states a figure the row does not: ${customer.prepared_message}`,
    );
  }
});

test("the summary and the table are derived from the same filtered list", async () => {
  // A panel whose total comes from one collection and whose rows come from another eventually
  // disagrees, and the disagreement reads as data loss.
  const dues = await getCustomerDueReminders(
    stubPool({ outstanding: LEDGER_ROWS, contacts: CONTACT_ROWS }),
    2,
    SETTINGS,
  );
  assert.equal(dues.summary.count, dues.customers.length);
  assert.equal(
    dues.summary.total_outstanding,
    Number(dues.customers.reduce((sum, customer) => sum + Number(customer.outstanding_amount), 0).toFixed(2)),
  );
  assert.equal(
    dues.summary.overdue_count,
    dues.customers.filter((customer) => OVERDUE_DUE_STATUSES.includes(customer.due_status)).length,
  );
  assert.equal(dues.summary.ready_for_review + dues.summary.no_number + dues.summary.opted_out, dues.customers.length);
});

test("no dialable number reaches the response", async () => {
  // `ai_assistant_view` is FROST's door and `FROST_DEFAULT_ROLES` is only its fallback, so a role
  // granted that permission explicitly would otherwise receive every debtor's phone number without
  // ever holding `customer_accounts`. The masked form is what the existing customer fact rows carry
  // and it is what this route carries too.
  const dues = await getCustomerDueReminders(
    stubPool({ outstanding: LEDGER_ROWS, contacts: CONTACT_ROWS }),
    2,
    SETTINGS,
  );
  const wire = JSON.stringify(dues);
  for (const number of ["919812345678", "9812345678", "919800000000"]) {
    assert.ok(!wire.includes(number), `the dialable number ${number} must not reach the panel`);
  }
  assert.ok(wire.includes("****5678"), "the masked form is what the panel gets");
});

test("a customer the contact query does not know is not given somebody else's number", async () => {
  // Entity ids are opaque strings. A `Number()` on one side of this join would not empty the table
  // the way the inventory bug did -- it would attach one customer's phone number to another
  // customer's debt, which is a worse outcome that looks entirely normal.
  const dues = await getCustomerDueReminders(
    stubPool({ outstanding: LEDGER_ROWS, contacts: [{ customer_id: "04", whatsapp_number: "919812345678", mobile_number: "9812345678", whatsapp_opt_in: true }] }),
    2,
    SETTINGS,
  );
  const ravi = dues.customers.find((customer) => customer.customer_name === "Ravi Traders");
  assert.equal(ravi.has_whatsapp_number, false, '"04" and 4 are different entities');
  assert.equal(ravi.contact_status, CONTACT_STATUS.NO_NUMBER);
});

/* ------------------------------------------------------- the route, through the real app */

/**
 * The route as Express actually serves it: a signed session, the FROST permission gate, and the
 * same scripted statements as above. The unit tests prove the SQL; these prove that reaching the
 * SQL requires getting past the gate, which is the half a unit test cannot see.
 */
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

let app;

const callDuesRoute = async ({ branchId = 2, permissionUser = OWNER_ROW, headers = {} } = {}) => {
  if (!app) app = loadServerApp();
  const token = issueDeviceSession({
    userId: 7,
    deviceId: "FZDEV-CUSTOMER-DUES",
    companyId: 1,
    branchId,
    role: "Owner",
    secret: TEST_SIGNING_KEY,
  });
  const statements = [];
  setQueryResponder((sql, values) => {
    statements.push({ sql, values });
    if (/FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql)) return permissionUser;
    if (/WITH credit_sales/.test(sql)) return { rows: LEDGER_ROWS, rowCount: LEDGER_ROWS.length };
    if (/FROM customers c/.test(sql)) return { rows: CONTACT_ROWS, rowCount: CONTACT_ROWS.length };
    if (/FROM business_settings/.test(sql)) return { rows: [{ business_name: SHOP }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(app, "GET", "/api/ai/reminders/customer-dues", {
      authorization: `Bearer ${token}`,
      ...headers,
    });
    return { response, statements };
  } finally {
    clearQueryResponder();
  }
};

test("the dues route answers the owner with drafts and says it sent nothing", async () => {
  const { response } = await callDuesRoute();
  assert.equal(response.status, 200);
  assert.equal(response.body.action_class, "READ_ONLY");
  assert.equal(response.body.approval_required, false);
  assert.match(response.body.delivery_policy, /prepares the text only/);
  assert.equal(response.body.customers.length, 2);
  assert.match(response.body.customers[0].prepared_message, /12,500\.50/);
});

test("the dues route reads the session's branch, never a branch the caller names", async () => {
  // `req.auth.branchId` is the only branch that may scope a FROST read. A caller asking for
  // somebody else's shop gets their own, and the bound values are what proves it.
  const { statements } = await callDuesRoute({ branchId: 2, headers: { "x-branch-id": "1" } });
  const ledger = statements.find(({ sql }) => /WITH credit_sales/.test(sql));
  const contacts = statements.find(({ sql }) => /FROM customers c/.test(sql));
  assert.deepEqual(ledger.values, [2]);
  assert.deepEqual(contacts.values, [2]);
});

test("a role without the FROST permission is refused the dues list", async () => {
  // FROST is the owner's assistant. The dues list is every customer's name, balance and contact
  // state in one response, so it sits behind the same door as every other FROST read.
  const { response } = await callDuesRoute({ permissionUser: { rows: [], rowCount: 0 } });
  assert.equal(response.status, 403);
  assert.equal(response.body.code, "FROST_PERMISSION_DENIED");
});

test("an unauthenticated caller never reaches the ledger", async () => {
  if (!app) app = loadServerApp();
  const statements = [];
  setQueryResponder((sql) => {
    statements.push(sql);
    return { rows: [], rowCount: 0 };
  });
  try {
    const response = await probe(app, "GET", "/api/ai/reminders/customer-dues", {});
    assert.ok(response.status === 401 || response.status === 403, `expected a refusal, got ${response.status}`);
    assert.ok(
      !statements.some((sql) => /WITH credit_sales/.test(sql)),
      "the books must not be read before the session is verified",
    );
  } finally {
    clearQueryResponder();
  }
});

test("a spoken reminder reaches the panel with the date he said", async () => {
  // The wiring, end to end. `/api/ai/query` already built a `reminder_draft` carrying his words;
  // without the date beside them the panel posts `due_at: null` and `getReminders` -- which orders
  // `due_at NULLS LAST` -- sorts the reminder he asked for below every dated one.
  if (!app) app = loadServerApp();
  const token = issueDeviceSession({
    userId: 7,
    deviceId: "FZDEV-REMINDER-DRAFT",
    companyId: 1,
    branchId: 2,
    role: "Owner",
    secret: TEST_SIGNING_KEY,
  });
  setQueryResponder((sql) => {
    if (/FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql)) return OWNER_ROW;
    // The audit insert has to hand back an id; everything else FROST touches on the way past --
    // settings, facts, cache, token usage -- answers emptily, so a missing side effect cannot be
    // mistaken for the behaviour under test.
    if (/INSERT INTO ai_conversations/i.test(sql)) return { rows: [{ id: 999 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const before = new Date();
  let response;
  try {
    response = await probe(
      app,
      "POST",
      "/api/ai/query",
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      { question: "kal yaad dilana supplier ko paisa dena hai" },
    );
  } finally {
    clearQueryResponder();
  }
  const after = new Date();
  assert.equal(response.status, 200);
  assert.equal(response.body.classification, "REMINDER_CREATE");
  // Still a read. The route describes what the panel should write; it must not have written it.
  assert.equal(response.body.action_class, "READ_ONLY");
  assert.ok(response.body.reminder_draft, "a reminder question must produce a draft");
  // `reminderTitleFrom` strips a *leading* asking phrase and keeps the rest verbatim, so a date
  // typed before it stays in the title. That is his sentence, not a paraphrase, and the title is
  // what has to tell him weeks later what he meant -- the date now has its own field beside it.
  assert.match(response.body.reminder_draft.title, /supplier ko paisa dena hai$/);
  // Tomorrow, from whichever UTC day the request actually ran on -- the assertion must not become
  // a once-a-day flake at midnight.
  const tomorrowOf = (moment) => new Date(moment.getTime() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  assert.ok(
    [tomorrowOf(before), tomorrowOf(after)].includes(response.body.reminder_draft.due_at),
    `due_at was ${response.body.reminder_draft.due_at}`,
  );
});

test("a reminder that names no date is drafted with none, not with today", async () => {
  if (!app) app = loadServerApp();
  const token = issueDeviceSession({
    userId: 7,
    deviceId: "FZDEV-REMINDER-DRAFT",
    companyId: 1,
    branchId: 2,
    role: "Owner",
    secret: TEST_SIGNING_KEY,
  });
  setQueryResponder((sql) => {
    if (/FROM\s+users\s+u\s+JOIN\s+roles\s+r/i.test(sql)) return OWNER_ROW;
    // The audit insert has to hand back an id; everything else FROST touches on the way past --
    // settings, facts, cache, token usage -- answers emptily, so a missing side effect cannot be
    // mistaken for the behaviour under test.
    if (/INSERT INTO ai_conversations/i.test(sql)) return { rows: [{ id: 999 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  let response;
  try {
    response = await probe(
      app,
      "POST",
      "/api/ai/query",
      { authorization: `Bearer ${token}`, "content-type": "application/json" },
      { question: "remind me to pay my suppliers" },
    );
  } finally {
    clearQueryResponder();
  }
  assert.equal(response.status, 200);
  assert.equal(response.body.reminder_draft.title, "pay my suppliers");
  assert.equal(response.body.reminder_draft.due_at, null);
});

/* ------------------------------------------------------------------------- nothing sends */

test("nothing on this path can send a WhatsApp message", () => {
  // The single rule this feature was built under. `POST /api/whatsapp/send-document` spends the
  // shop's live WhatsApp Cloud credentials and messages real customers; FROST prepares text and a
  // person presses send. Asserted against the source rather than against behaviour, because the
  // failure being guarded is somebody later adding the call, not this code making it today.
  //
  // Comments are stripped first, on purpose: these files say in prose exactly which route they must
  // never call, and a scan that could not tell an explanation from a call would force that warning
  // out of the source to keep itself green.
  const withoutComments = (source) => source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|\s)\/\/[^\n]*/g, "$1");
  for (const file of ["frostReminders.js", "aiBusinessAssistantService.js", "frostLanguage.js"]) {
    const code = withoutComments(fs.readFileSync(path.join(__dirname, file), "utf8"));
    for (const forbidden of ["send-document", "graph.facebook", "whatsapp_send_logs", "messaging_product", "whatsapp_settings", "access_token"]) {
      assert.ok(
        !code.includes(forbidden),
        `${file} references "${forbidden}" in code -- FROST must never be able to send a message on its own`,
      );
    }
    assert.ok(!/\bfetch\s*\(/.test(code), `${file} makes an outbound call`);
  }
});

test("the dues route says on the wire that it sends nothing", () => {
  // A panel or a script reading the payload is told the same thing the code says, so "FROST can
  // message my customers" cannot be assumed from a field that happens to look like a recipient.
  const source = fs.readFileSync(path.join(__dirname, "aiBusinessAssistantService.js"), "utf8");
  assert.match(source, /delivery_policy: "FROST prepares the text only\./);
  assert.match(source, /app\.get\("\/api\/ai\/reminders\/customer-dues"/);
});

/* ----------------------------------------------------- setting a due date after the fact */

/**
 * The second half of "fir due date set kr sku": a date the owner picks in the panel, rather than
 * one he said out loud. The words are read by `detectReminderDueDate`; this reads a date.
 */

test("a day is accepted and stored as the start of that day", () => {
  assert.equal(normalizeReminderDueAt("2026-09-30"), "2026-09-30 00:00:00");
  assert.equal(normalizeReminderDueAt("  2026-09-30  "), "2026-09-30 00:00:00");
});

test("clearing the date is a real answer, not a failure", () => {
  // A reminder with no date is the shape FROST creates when he named no day, so taking a date off
  // again has to be possible and has to be told apart from a date that could not be read.
  for (const value of [null, undefined, "", "   "]) {
    assert.equal(normalizeReminderDueAt(value), null, `${JSON.stringify(value)} should clear the date`);
  }
});

test("a date that cannot be read is refused, never quietly turned into no date", () => {
  // The silent-success failure this repo keeps paying for: a typo that clears the date while the
  // panel says "saved" leaves a reminder that will never come up again.
  for (const value of ["nonsense", "30-09-2026", "2026-13-01", "2026-00-10", "tomorrow"]) {
    assert.equal(normalizeReminderDueAt(value), undefined, `${JSON.stringify(value)} should be refused`);
  }
});

test("a day that does not exist is refused rather than rolled into the next month", () => {
  // `new Date("2026-02-31")` is not an error -- it is 3 March. A reminder silently moved to a
  // different day is worse than one refused, because nothing says it moved.
  assert.equal(normalizeReminderDueAt("2026-02-31"), undefined);
  assert.equal(normalizeReminderDueAt("2026-04-31"), undefined);
  assert.equal(normalizeReminderDueAt("2026-02-28"), "2026-02-28 00:00:00");
});

test("a full timestamp survives with its time", () => {
  assert.equal(normalizeReminderDueAt("2026-09-30T10:30:00Z"), "2026-09-30T10:30:00.000Z");
});

test("the words are read in one place only", () => {
  // Two date readers with their own idea of "tomorrow" is how the reminder FROST created and the
  // reminder the panel saved come to sit on different days.
  // Comments stripped first, so the module can keep *explaining* which words it deliberately does
  // not read -- the same technique the no-sending scan above uses, and for the same reason.
  const source = fs.readFileSync(path.join(__dirname, "frostReminders.js"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
  for (const word of ["kal", "tomorrow", "hafte", "tarikh"]) {
    assert.ok(!new RegExp(`["'\`][^"'\`]*\\b${word}\\b`).test(source),
      `frostReminders.js reads the word "${word}"; that belongs to detectReminderDueDate`);
  }
});
