import test from "node:test";
import assert from "node:assert/strict";

import {
  DUE_OUTREACH_ACTION,
  DUE_OUTREACH_STATUS,
  buildDueOutreachRows,
  normalizeWhatsappNumber,
  whatsappDraftLink,
} from "./frostDuesOutreach.js";

const due = (overrides = {}) => ({
  customer_id: "004",
  customer_name: "Kalu Ghantaghar",
  outstanding_amount: 2350.5,
  prepared_message: "Namaste Kalu Ghantaghar ji, Frooz se. Aapka ₹2,350.50 ka balance abhi baaki hai.",
  whatsapp_opt_in: true,
  ...overrides,
});

const customer = (overrides = {}) => ({
  id: "004",
  name: "Kalu Ghantaghar",
  whatsapp_number: "9876543210",
  ...overrides,
});

// -------------------------------------------------------------------------------------------
// Numbers
// -------------------------------------------------------------------------------------------

test("a ten digit Indian number gains its country code", () => {
  assert.equal(normalizeWhatsappNumber("9876543210"), "919876543210");
  assert.equal(normalizeWhatsappNumber("98765 43210"), "919876543210");
  assert.equal(normalizeWhatsappNumber("+91 98765-43210"), "919876543210");
  assert.equal(normalizeWhatsappNumber("00919876543210"), "919876543210");
});

test("a number that cannot be dialled comes back empty rather than nearly right", () => {
  for (const value of ["", null, undefined, "12345", "abcdefghij", "9876543210987654321"]) {
    assert.equal(normalizeWhatsappNumber(value), "", `${value} should not survive`);
  }
});

test("a link is only ever built with both a number and words", () => {
  assert.equal(whatsappDraftLink("", "Namaste"), "");
  assert.equal(whatsappDraftLink("9876543210", ""), "");
  assert.equal(whatsappDraftLink("9876543210", "   "), "");
  const link = whatsappDraftLink("9876543210", "Namaste ji, ₹100 baaki hai.");
  assert.ok(link.startsWith("https://wa.me/919876543210?text="));
  assert.ok(link.includes(encodeURIComponent("₹100")));
});

// -------------------------------------------------------------------------------------------
// The rows
// -------------------------------------------------------------------------------------------

test("a customer with a number and permission can be sent to", () => {
  const built = buildDueOutreachRows({ dues: [due()], customers: [customer()], canSend: true });
  assert.equal(built.status, DUE_OUTREACH_STATUS.OK);
  assert.equal(built.sendableCount, 1);
  const [row] = built.rows;
  assert.equal(row.action, DUE_OUTREACH_ACTION.SEND);
  assert.equal(row.whatsappNumber, "919876543210");
  assert.ok(row.link.startsWith("https://wa.me/919876543210?text="));
  assert.equal(row.blockedReason, "");
});

test("the id is matched canonically, so \"004\" and 4 are not confused", () => {
  // The pitfall CLAUDE.md names first. `4` is a different entity from `"004"`, and a lookup that
  // coerced either side would hand this row another customer's phone number.
  const built = buildDueOutreachRows({
    dues: [due({ customer_id: "004" })],
    customers: [customer({ id: 4, name: "Someone Else", whatsapp_number: "9000000000" })],
    canSend: true,
  });
  assert.equal(built.rows[0].action, DUE_OUTREACH_ACTION.NO_NUMBER);
  assert.equal(built.rows[0].whatsappNumber, "");
});

test("a customer who is not on this device keeps the words and says so", () => {
  const built = buildDueOutreachRows({ dues: [due()], customers: [], canSend: true });
  const [row] = built.rows;
  assert.equal(row.action, DUE_OUTREACH_ACTION.NO_NUMBER);
  assert.equal(row.prepared_message, due().prepared_message, "the draft must survive a failed lookup");
  assert.match(row.blockedReason, /not in the customer list/);
  assert.equal(built.sendableCount, 0);
});

test("a customer with no number at all is named as that, not as a missing customer", () => {
  const built = buildDueOutreachRows({
    dues: [due()],
    customers: [customer({ whatsapp_number: "", mobile_number: "" })],
    canSend: true,
  });
  assert.match(built.rows[0].blockedReason, /No WhatsApp or mobile number/);
});

test("a mobile number stands in when there is no WhatsApp number", () => {
  const built = buildDueOutreachRows({
    dues: [due()],
    customers: [customer({ whatsapp_number: "", mobile_number: "9876500000" })],
    canSend: true,
  });
  assert.equal(built.rows[0].whatsappNumber, "919876500000");
});

test("a customer who opted out is never sendable, and no number is returned for them", () => {
  const built = buildDueOutreachRows({
    dues: [due({ whatsapp_opt_in: false })],
    customers: [customer()],
    canSend: true,
  });
  const [row] = built.rows;
  assert.equal(row.action, DUE_OUTREACH_ACTION.OPTED_OUT);
  assert.equal(row.whatsappNumber, "");
  assert.equal(row.link, "");
  assert.match(row.blockedReason, /asked not to be messaged/);
  // The words stay readable: he can still ring them.
  assert.ok(row.prepared_message.length > 0);
});

test("a null opt-in means the customer was never asked, not that they refused", () => {
  const built = buildDueOutreachRows({
    dues: [due({ whatsapp_opt_in: null })],
    customers: [customer()],
    canSend: true,
  });
  assert.equal(built.rows[0].action, DUE_OUTREACH_ACTION.SEND);
});

test("without permission the row is still shown, as a reminder, with no number on it", () => {
  const built = buildDueOutreachRows({ dues: [due()], customers: [customer()], canSend: false });
  const [row] = built.rows;
  assert.equal(row.action, DUE_OUTREACH_ACTION.NOT_PERMITTED);
  assert.equal(row.whatsappNumber, "");
  assert.equal(row.link, "");
  assert.equal(built.sendableCount, 0);
  assert.equal(row.customer_name, "Kalu Ghantaghar", "the reminder half of the ask must survive");
});

test("the key is the customer, so a refresh does not reshuffle the list", () => {
  const first = buildDueOutreachRows({ dues: [due(), due({ customer_id: "17" })], customers: [], canSend: true });
  const second = buildDueOutreachRows({ dues: [due({ customer_id: "17" }), due()], customers: [], canSend: true });
  assert.deepEqual(first.rows.map((row) => row.key).sort(), second.rows.map((row) => row.key).sort());
});

// -------------------------------------------------------------------------------------------
// A failed read is not a quiet shop
// -------------------------------------------------------------------------------------------

test("a failure is unreadable, never an empty list", () => {
  const built = buildDueOutreachRows({ dues: null, customers: [], canSend: true, failure: "Request timed out." });
  assert.equal(built.status, DUE_OUTREACH_STATUS.UNREADABLE);
  assert.equal(built.rows.length, 0);
  assert.match(built.message, /Request timed out\./);
  assert.match(built.message, /not a short list/);
});

test("a list that is not a list is unreadable too", () => {
  for (const dues of [null, undefined, "", {}, 7]) {
    const built = buildDueOutreachRows({ dues, customers: [], canSend: true });
    assert.equal(built.status, DUE_OUTREACH_STATUS.UNREADABLE, `${JSON.stringify(dues)} should not read as an empty list`);
  }
});

test("an empty list really is an empty list", () => {
  const built = buildDueOutreachRows({ dues: [], customers: [], canSend: true });
  assert.equal(built.status, DUE_OUTREACH_STATUS.OK);
  assert.equal(built.rows.length, 0);
  assert.equal(built.message, "");
});

test("nothing in here throws, whatever arrives", () => {
  const hostile = { get customer_id() { throw new Error("no"); } };
  assert.doesNotThrow(() => buildDueOutreachRows({ dues: [hostile], customers: [customer()], canSend: true }));
  assert.doesNotThrow(() => buildDueOutreachRows({ dues: [null, 7, "x", due()], customers: null, canSend: true }));
  assert.doesNotThrow(() => buildDueOutreachRows());
  const survived = buildDueOutreachRows({ dues: [null, 7, "x", due()], customers: null, canSend: true });
  assert.equal(survived.rows.length, 1, "unusable entries are dropped, the real one is kept");
});

// -------------------------------------------------------------------------------------------
// The wiring in App.jsx. These are source-text assertions, which is what this repo can check for
// a 17.7k-line component -- and this is the one feature where the wrong wiring sends a real
// message to a real customer.
// -------------------------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const appJsx = readFileSync(join(repoRoot, "frontend/src/App.jsx"), "utf8");

/** The dues panel component, which is the only place dues rows are rendered. */
const duesPanel = () => {
  const start = appJsx.indexOf("function FrostDuesPanel(");
  assert.notEqual(start, -1, "the dues panel is gone from App.jsx");
  const end = appJsx.indexOf("function FrostPredictionsPanel(", start);
  assert.notEqual(end, -1, "the dues panel's end could not be found");
  return appJsx.slice(start, end);
};

test("the dues panel cannot send anything by itself", () => {
  const body = duesPanel();
  // The route that spends the shop's live WhatsApp Cloud credentials. Nothing on this screen may
  // reach it: the owner sends from WhatsApp, having read the words.
  assert.ok(!body.includes("send-document"), "the dues panel posts to the WhatsApp send route");
  assert.ok(!body.includes("axios."), "the dues panel makes its own requests; it must only render what it is given");
  assert.ok(!/send\s*all|sendAll/i.test(body), "the dues panel offers a bulk send");
  // One link per row, opened by the owner, with the text prefilled. That is the send.
  assert.match(body, /href=\{row\.link\}/);
});

test("a row that may not be sent is still shown, with the reason", () => {
  const body = duesPanel();
  assert.match(body, /row\.blockedReason/,
    "a customer who opted out or has no number must still appear; dropping them makes \"opted out\" look like \"owes nothing\"");
});

test("a failed read is not rendered as an empty table", () => {
  const body = duesPanel();
  assert.match(body, /DUE_OUTREACH_STATUS\.UNREADABLE/,
    "the panel no longer tells a failed read apart from a shop where nobody owes anything");
});

test("the number is resolved from this device, never taken off the FROST payload", () => {
  // `/api/ai/reminders/customer-dues` returns masked numbers on purpose. If the panel ever reads a
  // dialable number off that payload, that route has been widened and the masking is decoration.
  assert.ok(!appJsx.includes("whatsapp_number_masked ||"), "a masked number is being used as if it were dialable");
  assert.match(appJsx, /buildDueOutreachRows\(\{[\s\S]{0,200}customers,/,
    "the dues rows are no longer joined against this device's own customers collection");
});

test("a reminder's due date is saved deliberately, not on every keystroke", () => {
  const start = appJsx.indexOf("function FrostReminderDueDate(");
  assert.notEqual(start, -1, "the due-date control is gone from App.jsx");
  const body = appJsx.slice(start, appJsx.indexOf("function FrostDuesPanel(", start));
  // An auto-saving date box fires a request per digit and lands on 2026-01-01 on the way to
  // 2026-01-15.
  assert.ok(!/onChange=\{[^}]*onSet/.test(body), "the date is saved from onChange");
  assert.match(body, /onClick=\{save\}/);
  assert.match(appJsx, /action: "SET_DUE_DATE"/, "the panel no longer asks the server to set a date");
});

test("a date FROST read out of the question is said back to the owner", () => {
  // A misread date is only findable if FROST states what it understood. "Saved" alone hides a
  // reminder sitting on the wrong day.
  assert.match(appJsx, /Saved for \$\{formatDisplayDate\(draft\.due_at\)\}/);
  // And when the bell will ring. A reminder for tomorrow correctly stays out of today's bell, and
  // with nothing saying so that read as "the reminder is not working" (23 Sep 2026).
  assert.match(appJsx, /The bell will ring on that day\./);
  assert.match(appJsx, /due_at: draft\.due_at \|\| null/);
});
