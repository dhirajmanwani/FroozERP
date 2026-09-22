"use strict";

/**
 * The text the owner reviews before he sends anything, and nothing else.
 *
 * The owner asked for two things about customers who owe him money: that FROST either message them
 * or remind him about them. This module does the second half of that and deliberately stops there.
 * It builds a *draft* -- a string -- out of figures that were already read from the books, and has
 * no idea how to send it. `POST /api/whatsapp/send-document` spends the shop's real WhatsApp Cloud
 * credentials against real customers' numbers; nothing in here reaches it, schedules it or makes it
 * reachable, because the only safe version of "FROST messages my customers" is one where a person
 * read the words and pressed send for that one message.
 *
 * ## The rule the message has to obey
 *
 * Every figure in the draft comes out of the row it was built from. Not rounded up to a nicer
 * number, not "about ten thousand", not a figure the model liked better. That is the same rule
 * `assertGroundedAnswer` enforces on FROST's answers, and it matters more here than there: an
 * answer with an invented figure misleads the owner, who knows his own books; a *message* with an
 * invented figure goes out under the shop's name to a customer, who does not.
 *
 * ## Tone
 *
 * No deadline, no late fee, no "failing which". A fruit shop's credit customers are neighbours who
 * come back next week, and a demand letter costs more than the balance it chases. The draft asks,
 * once, and leaves the timing to the customer.
 */

const { money } = require("./frostAnswer");

const cleanText = (value) => (typeof value === "string" ? value.trim() : "");

/** What is stopping this customer being messaged at all, in the panel's words. */
const CONTACT_STATUS = Object.freeze({
  READY: "READY_FOR_REVIEW",
  NO_NUMBER: "NO_NUMBER",
  OPTED_OUT: "OPTED_OUT",
});

/**
 * Why a draft exists for a customer who cannot be messaged.
 *
 * Because the owner can still read it aloud on the phone, or copy it. Suppressing the draft for a
 * customer with no number would make "no number" look like "nothing owed", and an absent thing that
 * should be there must never render as an empty one -- the same rule that keeps `Products: 0` from
 * standing in for a failed load.
 */
const contactStatusFor = ({ whatsappNumber = "", mobileNumber = "", whatsappOptIn = true } = {}) => {
  if (!cleanText(whatsappNumber) && !cleanText(mobileNumber)) return CONTACT_STATUS.NO_NUMBER;
  // `false` only. A null column means the customer was never asked, which the schema defaults to
  // opted in; reading null as a refusal would silently hide every customer added before the column
  // existed.
  if (whatsappOptIn === false) return CONTACT_STATUS.OPTED_OUT;
  return CONTACT_STATUS.READY;
};

/**
 * The draft itself.
 *
 * Written in Hinglish, in Latin letters, because that is the language the shop is actually run in
 * -- the whole of `frostLanguage.js` exists because the owner types this way, and a message he has
 * to translate before sending is a message he will retype instead. He can edit it in the panel; the
 * point of the draft is that he rarely has to.
 *
 * Exactly one figure goes in: the outstanding amount. The due date and the overdue day count are
 * carried on the row for the owner's own screen and kept out of the customer's message on purpose
 * -- "13 days overdue" reads as a count being kept, which is the tone this draft is avoiding, and
 * every extra figure is one more thing that can be wrong in a message sent under the shop's name.
 */
const buildCustomerReminderMessage = ({ customerName = "", shopName = "", outstandingAmount = 0 } = {}) => {
  const name = cleanText(customerName);
  const shop = cleanText(shopName);
  const amount = Number(outstandingAmount);
  if (!Number.isFinite(amount) || amount <= 0) return "";
  // A nameless row is the walk-in customer the ledger groups under no id. "Namaste ji" is how he
  // would open that message himself; "Namaste  ji" with the gap, or the word "Customer", is how a
  // system opens it.
  const greeting = name ? `Namaste ${name} ji` : "Namaste ji";
  // The shop has to name itself: a payment message from an unnamed number is the shape of every
  // scam the customer has been warned about.
  const from = shop ? `${shop} se` : "aapki dukaan se";
  return `${greeting}, ${from}. Aapka ${money(amount)} ka balance abhi baaki hai. `
    + `Jab suvidha ho, bata dijiyega kab tak de payenge. Dhanyawad.`;
};

/**
 * One customer's row for the dues panel: the figures as the ledger produced them, the draft, and
 * an honest account of whether the owner can actually send it.
 *
 * `maskNumber` is passed in rather than imported so that the masking rule stays defined in one
 * place -- `aiBusinessAssistantService.js` already owns it, and two copies of a disclosure rule is
 * one copy too many. See the route for why the dialable number is not returned at all.
 */
const prepareCustomerDueReminder = (row = {}, { shopName = "", maskNumber = () => "" } = {}) => {
  const whatsappNumber = cleanText(row.whatsapp_number);
  const mobileNumber = cleanText(row.mobile_number);
  return {
    customer_id: row.customer_id ?? null,
    customer_name: cleanText(row.customer_name),
    outstanding_amount: row.outstanding_amount,
    oldest_invoice_date: row.oldest_invoice_date ?? null,
    oldest_due_date: row.oldest_due_date ?? null,
    last_payment_date: row.last_payment_date ?? null,
    overdue_days: row.overdue_days ?? null,
    due_status: row.due_status || "NO_DUE_DATE",
    risk_classification: row.risk_classification || "NONE",
    // Booleans, not the numbers. A masked number is "" for anything shorter than four digits, so
    // the panel cannot tell "no number on file" from "masked to nothing" without these.
    has_whatsapp_number: Boolean(whatsappNumber),
    has_mobile_number: Boolean(mobileNumber),
    whatsapp_number_masked: maskNumber(whatsappNumber),
    mobile_number_masked: maskNumber(mobileNumber),
    whatsapp_opt_in: row.whatsapp_opt_in !== false,
    contact_status: contactStatusFor({
      whatsappNumber,
      mobileNumber,
      whatsappOptIn: row.whatsapp_opt_in,
    }),
    prepared_message: buildCustomerReminderMessage({
      customerName: row.customer_name,
      shopName,
      outstandingAmount: row.outstanding_amount,
    }),
    // Said on every row, because this is the field a future caller would be tempted to hand to a
    // sender. FROST drafts; a person sends.
    delivery: "DRAFT_FOR_OWNER_REVIEW",
  };
};

/**
 * A due date the owner typed or picked, in a form Postgres will accept -- or a refusal.
 *
 * Three answers, and the caller has to be able to tell them apart:
 *
 * - **`null`** -- he cleared the date. Legitimate: a reminder with no date is the shape FROST
 *   creates when he named no day, and taking a date off again must be possible.
 * - **a string** -- a date that was read.
 * - **`undefined`** -- it could not be read. Deliberately not `null`, because a typo that clears
 *   the date instead of being reported is the silent-success failure this repo keeps paying for:
 *   the panel would say "saved" and the reminder would quietly have no date at all.
 *
 * Accepted: `YYYY-MM-DD`, and a full ISO timestamp. Nothing cleverer -- the *words* ("kal", "agle
 * hafte") are read by `detectReminderDueDate` in `frostLanguage.js`, against a reference moment
 * passed in, and a second date reader here with its own idea of "tomorrow" is how the two come to
 * disagree.
 *
 * The month and day are checked against what came back, because `new Date("2026-02-31")` is not an
 * error -- it rolls into March, and a reminder silently moved to a different day is worse than one
 * refused.
 */
const normalizeReminderDueAt = (value) => {
  if (value === null || value === undefined) return null;
  const raw = cleanText(String(value));
  if (!raw) return null;
  const dayOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (dayOnly) {
    const [, year, month, day] = dayOnly;
    const parsed = new Date(`${raw}T00:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return undefined;
    // The rollover check. "2026-02-31" parses; it just is not the day that was asked for.
    if (parsed.getUTCFullYear() !== Number(year)
      || parsed.getUTCMonth() + 1 !== Number(month)
      || parsed.getUTCDate() !== Number(day)) return undefined;
    return `${raw} 00:00:00`;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) return undefined;
  return parsed.toISOString();
};

module.exports = {
  CONTACT_STATUS,
  buildCustomerReminderMessage,
  contactStatusFor,
  normalizeReminderDueAt,
  prepareCustomerDueReminder,
};
