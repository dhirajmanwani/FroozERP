/**
 * The customers who owe money, turned into something the owner can act on one row at a time.
 *
 * ## What was asked, and the half of it we are not building
 *
 * On 22 Sep 2026: *"customers ko yaad dilane k liye frost whatsapp kre ya mujhe remind kraye jinka
 * baaki he"* -- FROST should either message the customers who owe, or remind him about them.
 *
 * FROST does not message them. `POST /api/whatsapp/send-document` spends the shop's real WhatsApp
 * Cloud credentials against real customers' numbers, and a wrong figure, a wrong name or a wrong
 * row in that message goes out under the shop's name to a neighbour who will read it as the shop's
 * word. A draft that is wrong costs a moment; a message that is wrong costs a customer. So FROST
 * prepares the words and this module works out who they can go to; the owner reads the row and
 * presses send himself, once, per customer.
 *
 * Pressing send opens WhatsApp with the text already in it (`wa.me`). Nothing here posts to the
 * send route, and nothing here can send without a person completing it inside WhatsApp. That is
 * deliberate and is the whole safety argument: there is no code path from a FROST answer to a
 * customer's phone.
 *
 * ## Why the number is resolved here and not sent by the server
 *
 * `GET /api/ai/reminders/customer-dues` returns masked numbers only -- it is a FROST route, and FROST's job
 * is not to hand out contact details. The dialable number is already in this app: the customers
 * collection is loaded for the customer screens and the WhatsApp recipient picker. So the row and
 * the number meet on the device that already holds both, and the server discloses nothing new.
 *
 * A row whose customer is not in that collection keeps its draft and says the number could not be
 * found. It does not silently disappear: a customer who owes money vanishing from a dues list
 * because a lookup missed is the same class of fault as an error rendering as zero.
 */

import { canonicalInventoryId } from "./stockInventory.js";

/**
 * A WhatsApp number in the form `wa.me` wants: digits only, country code included.
 *
 * Moved out of App.jsx so the dues rows and the recipient picker cannot drift into two different
 * ideas of what a valid number is. The default country code is India's because the shop is; a
 * number already carrying one is left alone.
 */
export const normalizeWhatsappNumber = (value, defaultCountryCode = "91") => {
  let digits = String(value || "").trim().replace(/[^\d+]/g, "");
  if (!digits) return "";
  if (digits.startsWith("00")) digits = digits.slice(2);
  if (digits.startsWith("+")) digits = digits.slice(1);
  digits = digits.replace(/\D/g, "");
  const countryCode = String(defaultCountryCode || "91").replace(/\D/g, "") || "91";
  if (digits.length === 10) digits = `${countryCode}${digits}`;
  return digits.length >= 11 && digits.length <= 15 ? digits : "";
};

/** What the owner can do with a row, and when he cannot, why. */
export const DUE_OUTREACH_ACTION = Object.freeze({
  /** A number was found and the customer has not opted out. The Send button works. */
  SEND: "SEND",
  /** The words are there; the number is not. He can still copy them or ring the customer. */
  NO_NUMBER: "NO_NUMBER",
  /** The customer asked not to be messaged. The draft stays readable; the button does not appear. */
  OPTED_OUT: "OPTED_OUT",
  /** This user may not send on the shop's behalf. The row is still shown, as a reminder. */
  NOT_PERMITTED: "NOT_PERMITTED",
});

/** Whether the list was read at all. The caller switches on this, never on `rows.length`. */
export const DUE_OUTREACH_STATUS = Object.freeze({
  OK: "ok",
  UNREADABLE: "unreadable",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

const numberFor = (customer = {}) =>
  normalizeWhatsappNumber(customer.whatsapp_number)
  || normalizeWhatsappNumber(customer.mobile_number)
  || normalizeWhatsappNumber(customer.phone_number);

/**
 * Index the customers collection by canonical id.
 *
 * `canonicalInventoryId` rather than `String(id)`, because CLAUDE.md's first pitfall is exactly
 * this: `"004"` and `4` are different entities, and a join with one side coerced and the other not
 * silently empties a list while every total above it stays right.
 */
const indexCustomers = (customers) => {
  const byId = new Map();
  if (!Array.isArray(customers)) return byId;
  for (const customer of customers) {
    if (!customer || typeof customer !== "object") continue;
    const id = canonicalInventoryId(customer.id ?? customer.customer_id);
    if (!id) continue;
    if (!byId.has(id)) byId.set(id, customer);
  }
  return byId;
};

/**
 * The link that opens WhatsApp with this message already typed.
 *
 * Only ever built for a row that has a number. `wa.me` with no number opens a contact picker, and
 * a Send button that opens a picker is a button that will eventually send the wrong person another
 * customer's balance.
 */
export const whatsappDraftLink = (number, message) => {
  const dialable = normalizeWhatsappNumber(number);
  const words = text(message);
  if (!dialable || !words) return "";
  return `https://wa.me/${dialable}?text=${encodeURIComponent(words)}`;
};

const actionFor = ({ optedOut, dialable, canSend }) => {
  if (optedOut) return DUE_OUTREACH_ACTION.OPTED_OUT;
  if (!dialable) return DUE_OUTREACH_ACTION.NO_NUMBER;
  if (!canSend) return DUE_OUTREACH_ACTION.NOT_PERMITTED;
  return DUE_OUTREACH_ACTION.SEND;
};

/**
 * The dues rows, each with the words FROST wrote and an honest account of what can be done with it.
 *
 * @param {object} input
 * @param {Array<object>} input.dues      rows from `GET /api/ai/reminders/customer-dues` (`data.customers`)
 * @param {Array<object>} input.customers the app's own customers collection, for the number
 * @param {boolean} input.canSend         whether this user may send on the shop's behalf
 * @param {string} [input.failure]        the load error, when the request failed
 * @returns {{status: string, rows: Array<object>, message: string, sendableCount: number}}
 */
export const buildDueOutreachRows = ({ dues, customers, canSend = false, failure = "" } = {}) => {
  try {
    const failureMessage = text(failure);
    if (failureMessage) {
      return {
        status: DUE_OUTREACH_STATUS.UNREADABLE,
        rows: [],
        message: `The list of customers who owe could not be read, so this is not a short list -- it is no list. ${failureMessage}`,
        sendableCount: 0,
      };
    }
    if (!Array.isArray(dues)) {
      return {
        status: DUE_OUTREACH_STATUS.UNREADABLE,
        rows: [],
        message: "FROST sent the dues list in a shape this app could not read. Reopen FROST, and restart the app if it stays empty.",
        sendableCount: 0,
      };
    }
    const byId = indexCustomers(customers);
    const rows = [];
    for (const due of dues) {
      if (!due || typeof due !== "object") continue;
      const id = canonicalInventoryId(due.customer_id);
      const customer = id ? byId.get(id) : null;
      const dialable = customer ? numberFor(customer) : "";
      // The server's own reading of the opt-in wins. It read the column; this side is only
      // resolving a number the server deliberately did not send.
      const optedOut = due.whatsapp_opt_in === false;
      const message = text(due.prepared_message);
      const action = actionFor({ optedOut, dialable, canSend });
      rows.push({
        ...due,
        // Kept out of the row's identity on purpose -- the key is the customer, so a refreshed list
        // does not reshuffle or re-key while the owner is working down it.
        key: id || `due-${rows.length}`,
        hasDialableNumber: Boolean(dialable),
        // Not returned at all when the row may not be sent. A number on a row with no Send button
        // is a contact detail disclosed for nothing.
        whatsappNumber: action === DUE_OUTREACH_ACTION.SEND ? dialable : "",
        link: action === DUE_OUTREACH_ACTION.SEND ? whatsappDraftLink(dialable, message) : "",
        action,
        // Said in the words the owner reads, not as a code the panel has to translate twice.
        blockedReason: action === DUE_OUTREACH_ACTION.OPTED_OUT
          ? "This customer asked not to be messaged."
          : action === DUE_OUTREACH_ACTION.NO_NUMBER
            ? (customer ? "No WhatsApp or mobile number on file." : "This customer is not in the customer list on this device.")
            : action === DUE_OUTREACH_ACTION.NOT_PERMITTED
              ? "You do not have permission to send on WhatsApp."
              : "",
      });
    }
    return {
      status: DUE_OUTREACH_STATUS.OK,
      rows,
      message: "",
      sendableCount: rows.filter((row) => row.action === DUE_OUTREACH_ACTION.SEND).length,
    };
  } catch {
    return {
      status: DUE_OUTREACH_STATUS.UNREADABLE,
      rows: [],
      message: "The list of customers who owe could not be read. Reopen FROST, and restart the app if it stays empty.",
      sendableCount: 0,
    };
  }
};
