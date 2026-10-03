/**
 * Handing a document to WhatsApp Desktop from the counter app (3 Oct 2026).
 *
 * The owner asked for "Send on WhatsApp" to open his WhatsApp straight on the customer's chat.
 * When the shop's WhatsApp Business API is not set up (or refuses), the app now: puts the bill's
 * PDF on the Windows clipboard as a file, opens WhatsApp on that customer's chat with the message
 * typed in, and tells the cashier to press Ctrl+V and Enter. WhatsApp lets no app press Send, so
 * that last step stays a person's.
 *
 * Only the wording and the choice of who is preselected live here; the clipboard and the opening
 * are Tauri commands (`copy_file_to_clipboard`, `open_whatsapp_chat`) in src-tauri/src/lib.rs.
 */

export const WHATSAPP_OPENED = Object.freeze({ APP: "app", BROWSER: "browser" });

/**
 * The recipients ticked when the send window opens. A bill or receipt carries its one customer, and
 * making the cashier tick the only name on the list was a click that did nothing but slow the
 * counter down. With several names, or a name without a usable number, nothing is preselected.
 */
export const initialWhatsappSelection = (recipients) => {
  const list = Array.isArray(recipients) ? recipients : [];
  if (list.length !== 1) return new Set();
  const [only] = list;
  const hasNumber = String(only?.phoneNumber || only?.whatsappNumber || only?.mobileNumber || "").trim() !== "";
  return hasNumber && only?.optIn !== false && typeof only?.key === "string" ? new Set([only.key]) : new Set();
};

/**
 * What the cashier reads after the hand-off. `opened` is what `open_whatsapp_chat` returned ("app",
 * "browser") or "" when it failed; `copied` is whether the PDF reached the clipboard. Only what
 * actually happened is claimed.
 */
export const describeChatHandoff = ({ opened = "", copied = false, fileName = "", name = "", error = "", others = 0 } = {}) => {
  const who = String(name || "").trim() || "the customer";
  const attach = copied
    ? "The PDF is copied: press Ctrl+V, then Enter."
    : `The PDF could not be copied, so it was saved as ${fileName}. Attach it, then Send.`;
  const rest = others > 0 ? ` Only the first number was opened; send to the other ${others} the same way.` : "";
  if (opened === WHATSAPP_OPENED.APP) {
    return { tone: copied ? "ok" : "warning", text: `WhatsApp is opening the chat with ${who}. ${attach}${rest}` };
  }
  if (opened === WHATSAPP_OPENED.BROWSER) {
    return { tone: "warning", text: `WhatsApp Desktop did not open, so the chat with ${who} is opening in the browser. ${attach}${rest}` };
  }
  return {
    tone: "error",
    text: `WhatsApp could not be opened${error ? `: ${error}` : ""}. ${copied ? "The PDF is copied; open the chat yourself and press Ctrl+V." : `The PDF was saved as ${fileName}.`}`,
  };
};
