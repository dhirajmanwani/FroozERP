/**
 * Plain words for the server's named refusals.
 *
 * The auth-hardening routes answer with a `code` and a message. The server's own message is the
 * better one when it is there (a lock message carries how long is left), so it is used first; the
 * text below is what a person sees when a refusal arrives without one. A code not listed here is not
 * this module's business, and the caller's own handling applies ("" is returned).
 */

export const REFUSAL_MESSAGES = Object.freeze({
  CURRENT_PASSWORD_REQUIRED: "Enter your current password to change it.",
  CURRENT_PASSWORD_INVALID: "Your current password is not correct.",
  USER_LOCKED: "Too many wrong passwords. This account is locked for a while; try again later.",
  OWNER_REQUIRED_FOR_PRIVILEGED_ACCOUNT: "Only the Owner can add, change or remove an Owner or Admin account.",
  USER_NOT_IN_YOUR_BRANCH: "You can only manage the staff of your own shop.",
  OWNER_REQUIRED_FOR_PRIVILEGED_ROLE: "Only the Owner can change what the Owner and Admin roles may do.",
  BILLING_PERMISSION_REQUIRED: "You do not have permission to create bills. Ask the Owner to allow Billing for your role.",
  PURCHASE_PERMISSION_REQUIRED: "You do not have permission to record purchases. Ask the Owner to allow Purchases for your role.",
  REPORTS_PERMISSION_REQUIRED: "You do not have permission to view reports. Ask the Owner to allow Reports for your role.",
  EXIT_CODE_ATTEMPTS_LOCKED: "Too many wrong exit codes. Wait a few minutes, then try again.",
});

export const plainRefusalMessage = (error) => {
  const data = error?.response?.data;
  const code = String(data?.code ?? "").trim();
  if (!code || !Object.prototype.hasOwnProperty.call(REFUSAL_MESSAGES, code)) return "";
  const serverMessage = typeof data?.message === "string" ? data.message.trim() : "";
  return serverMessage || REFUSAL_MESSAGES[code];
};
