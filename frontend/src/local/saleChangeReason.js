/**
 * Why a bill was cancelled or edited, and whether someone else has to approve it.
 *
 * ## What was asked
 *
 * A cancel or edit used to take any free text as its reason, and any user with the permission could
 * do it alone. The owner asked for a short fixed list of reasons, and for a cashier's cancel or edit
 * to need the Owner or an Admin to type their password on the counter first.
 *
 * ## Rules this module keeps
 *
 * 1. **The stored reason is plain text.** It is the label itself ("Duplicate bill"), or
 *    "Other: <what was typed>". No schema change: the existing reason columns hold it, the server
 *    keeps accepting any non-empty reason, and a bill cancelled before this change still reads back
 *    (as Other, with its old text).
 * 2. **Approval fails closed.** Only a role that is plainly Owner or Admin skips it. An empty,
 *    unknown or unreadable role needs approval.
 * 3. **Approval needs the cloud, and LOCAL_ONLY never reaches it.** Offline, LOCAL_ONLY, or a cloud
 *    gate that says no: the change is refused before anything is written, with one sentence that
 *    says what to do. This module makes no calls; it only says which way to go.
 * 4. **Every refusal says nothing was saved.** A failed approval must never look like a change
 *    that went through.
 */

export const SALE_CHANGE_REASON_CODE = Object.freeze({
  WRONG_ITEM_OR_RATE: "WRONG_ITEM_OR_RATE",
  CUSTOMER_REFUSED: "CUSTOMER_REFUSED",
  DUPLICATE_BILL: "DUPLICATE_BILL",
  PAYMENT_ISSUE: "PAYMENT_ISSUE",
  OTHER: "OTHER",
});

/** The reasons, in the order the picker shows them. Labels are the stored text — do not reword. */
export const SALE_CHANGE_REASONS = Object.freeze([
  Object.freeze({ code: SALE_CHANGE_REASON_CODE.WRONG_ITEM_OR_RATE, label: "Wrong item or rate" }),
  Object.freeze({ code: SALE_CHANGE_REASON_CODE.CUSTOMER_REFUSED, label: "Customer refused" }),
  Object.freeze({ code: SALE_CHANGE_REASON_CODE.DUPLICATE_BILL, label: "Duplicate bill" }),
  Object.freeze({ code: SALE_CHANGE_REASON_CODE.PAYMENT_ISSUE, label: "Payment issue" }),
  Object.freeze({ code: SALE_CHANGE_REASON_CODE.OTHER, label: "Other" }),
]);

const OTHER_PREFIX = "Other:";

const text = (value) => (typeof value === "string" ? value.trim() : "");

const reasonByCode = (code) => SALE_CHANGE_REASONS.find((reason) => reason.code === code) || null;

/**
 * The reason text to send, from what the picker holds.
 *
 * @param {{code?: string, otherText?: string}} choice
 * @returns {{ok: true, reason: string} | {ok: false, message: string}}
 */
export const composeSaleChangeReason = ({ code, otherText } = {}) => {
  const picked = reasonByCode(text(code));
  if (!picked) return { ok: false, message: "Choose a reason." };
  if (picked.code !== SALE_CHANGE_REASON_CODE.OTHER) return { ok: true, reason: picked.label };
  const typed = text(otherText);
  if (!typed) return { ok: false, message: "Type the reason for Other." };
  return { ok: true, reason: `${OTHER_PREFIX} ${typed}` };
};

/**
 * A stored reason back into the picker's shape.
 *
 * An exact label is that reason; "Other: x" is Other with x; anything else is a reason written
 * before the fixed list existed, and reads as Other with its whole text so nothing is lost. An
 * empty reason is no choice at all.
 *
 * @param {string} value
 * @returns {{code: string, otherText: string}}
 */
export const parseSaleChangeReason = (value) => {
  const stored = text(value);
  if (!stored) return { code: "", otherText: "" };
  const exact = SALE_CHANGE_REASONS.find((reason) => reason.label === stored)
    || SALE_CHANGE_REASONS.find((reason) => reason.label.toLowerCase() === stored.toLowerCase());
  if (exact) return { code: exact.code, otherText: "" };
  if (stored.slice(0, OTHER_PREFIX.length).toLowerCase() === OTHER_PREFIX.toLowerCase()) {
    return { code: SALE_CHANGE_REASON_CODE.OTHER, otherText: stored.slice(OTHER_PREFIX.length).trim() };
  }
  return { code: SALE_CHANGE_REASON_CODE.OTHER, otherText: stored };
};

const SELF_APPROVING_ROLES = new Set(["owner", "admin"]);

/**
 * Does a cancel or edit by someone in this role need Owner or Admin approval?
 * False only for Owner or Admin (any case, surrounding spaces ignored). Anything else — including
 * no role at all — needs approval.
 */
export const saleChangeNeedsApproval = (role) => !SELF_APPROVING_ROLES.has(text(role).toLowerCase());

export const SALE_CHANGE_APPROVAL_MODE = Object.freeze({
  NONE: "NONE",
  CLOUD: "CLOUD",
  REFUSED: "REFUSED",
});

export const SALE_CHANGE_APPROVAL_OFFLINE_MESSAGE = "Cancelling or editing a bill needs Owner or Admin approval, and that needs a connection. Connect to the internet, or ask the Owner or Admin to do it on this counter.";

/**
 * Which way an approval goes, decided before anything is written.
 *
 * `needsApproval` must be exactly `false` to skip approval, and `cloudGateAllowed` exactly `true`
 * to reach the cloud — a missing gate answer refuses rather than guesses. Offline or LOCAL_ONLY
 * refuses whatever the gate says, so LOCAL_ONLY never makes the approval call. REFUSED means: do not write the
 * change locally, do not call the cloud, show `message`.
 *
 * @returns {{mode: "NONE"} | {mode: "CLOUD"} | {mode: "REFUSED", message: string}}
 */
export const resolveSaleChangeApprovalRoute = ({
  needsApproval,
  offlineMode,
  localOnly,
  cloudGateAllowed,
} = {}) => {
  if (needsApproval === false) return { mode: SALE_CHANGE_APPROVAL_MODE.NONE };
  if (offlineMode || localOnly || cloudGateAllowed !== true) {
    return { mode: SALE_CHANGE_APPROVAL_MODE.REFUSED, message: SALE_CHANGE_APPROVAL_OFFLINE_MESSAGE };
  }
  return { mode: SALE_CHANGE_APPROVAL_MODE.CLOUD };
};

const NOT_SAVED = "Nothing was saved.";

const APPROVAL_ERROR_MESSAGES = Object.freeze({
  APPROVER_CREDENTIALS_INVALID: `The Owner or Admin username or password is wrong. ${NOT_SAVED}`,
  APPROVER_NOT_ALLOWED: `That person cannot approve this. Only an active Owner or Admin can. ${NOT_SAVED}`,
  REQUESTER_NOT_ALLOWED: `You are not allowed to cancel or edit bills. ${NOT_SAVED}`,
  APPROVAL_ATTEMPTS_LOCKED: `Too many wrong approval attempts. Wait 15 minutes and try again. ${NOT_SAVED}`,
  PASSWORD_RESET_REQUIRED: `The approver's password has to be reset before they can approve. ${NOT_SAVED}`,
  SALE_CHANGE_APPROVAL_REQUIRED: `This change needs Owner or Admin approval, and the approval was missing, already used or expired. Ask for approval again. ${NOT_SAVED}`,
});

export const SALE_CHANGE_APPROVAL_UNREACHABLE_MESSAGE = `The approval could not be checked because the server could not be reached. ${NOT_SAVED}`;
export const SALE_CHANGE_APPROVAL_GENERIC_MESSAGE = `The approval could not be completed. ${NOT_SAVED}`;

/** The server's error code, from an axios error (`error.response.data.code`) or a plain `{code}`. */
export const approvalErrorCode = (error) => {
  if (!error || typeof error !== "object") return "";
  return text(error.response?.data?.code) || text(error.data?.code) || text(error.code);
};

/**
 * One plain line for a failed approval or a refused cancel/edit. Always ends by saying nothing was
 * saved. Known server codes get their own sentence; a request that never reached the server says
 * so; anything else gets a generic line. The server's own wording is not shown for known codes, so
 * a stray technical message cannot reach the counter screen.
 */
export const describeApprovalError = (error) => {
  const code = approvalErrorCode(error);
  if (code && Object.prototype.hasOwnProperty.call(APPROVAL_ERROR_MESSAGES, code)) return APPROVAL_ERROR_MESSAGES[code];
  const isAxiosLike = error && typeof error === "object" && ("isAxiosError" in error || "request" in error);
  if (isAxiosLike && !error.response) return SALE_CHANGE_APPROVAL_UNREACHABLE_MESSAGE;
  return SALE_CHANGE_APPROVAL_GENERIC_MESSAGE;
};
