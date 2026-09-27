"use strict";

/**
 * Owner/Admin approval for cancelling or editing a completed bill.
 *
 * ## The rule
 *
 * A bill that has been handed to a customer is money the shop has already recorded. Anyone below
 * Owner or Admin who cancels or edits one needs an Owner or Admin to type their own username and
 * password on the counter first. The server checks that password (`POST
 * /api/v3/sale-change-approvals`) and issues a single-use approval bound to one action, one bill,
 * one requester, one company and one device. The change itself -- on the browser path
 * (`updateSaleHandler`, `cancelSaleHandler`) and on the offline-sync path
 * (`processPosSaleEditOperation`, `processPosSaleCancelOperation`) -- consumes it through
 * `authorizeSaleChange`, and the approver is written to `sale_audit_trail.approved_by`.
 *
 * ## Why the logic lives here
 *
 * `server.js` is too large to test by driving it. Everything that decides something -- who needs
 * approval, what a well-formed request is, whether a stored approval matches the change being made,
 * and when a requester has guessed too often -- is a pure function in this file, with no database
 * and no clock of its own, so each branch is tested directly in `saleChangeApproval.test.js`.
 *
 * ## What an approval can never be
 *
 * - **Reused.** CONSUMED is terminal; a second change needs a second approval.
 * - **Moved.** A different bill, action, cashier, company or device refuses it.
 * - **Kept forever.** It expires after seven days, so a forgotten one cannot be found later.
 * - **Trusted from the client.** The desktop only carries the id; every property is re-read here.
 */

/** The roles that may approve, and that need no approval themselves. */
const APPROVER_ROLES = new Set(["Owner", "Admin"]);

const APPROVAL_ACTIONS = Object.freeze(["cancel", "edit"]);

const APPROVAL_STATUS = Object.freeze({
  ISSUED: "ISSUED",
  CONSUMED: "CONSUMED",
  FAILED: "FAILED",
});

/** How long an issued approval stays usable. Long enough to cover a counter that goes offline. */
const APPROVAL_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Failed approver-password attempts, counted per requester.
 *
 * Counted against the cashier asking, never against the Owner or Admin named: bumping the
 * approver's own login lockout would let any cashier lock the Owner out of the shop by typing
 * the Owner's username five times.
 */
const FAILURE_LIMIT = 5;
const FAILURE_WINDOW_MINUTES = 15;
const FAILURE_WINDOW_MS = FAILURE_WINDOW_MINUTES * 60 * 1000;
// A second, daily ceiling. Five per quarter hour alone would still allow ~480 guesses a day at an
// Owner's password; ten wrong attempts in a day stops the requester until the next day.
const DAILY_FAILURE_LIMIT = 10;

const SALE_REF_MAX_LENGTH = 180;
const USERNAME_MAX_LENGTH = 80;
const PASSWORD_MAX_LENGTH = 512;
const REASON_MAX_LENGTH = 500;
const APPROVAL_ID_MAX_LENGTH = 64;

const CODES = Object.freeze({
  REQUEST_INVALID: "APPROVAL_REQUEST_INVALID",
  NOT_NEEDED: "APPROVAL_NOT_NEEDED",
  CREDENTIALS_INVALID: "APPROVER_CREDENTIALS_INVALID",
  APPROVER_NOT_ALLOWED: "APPROVER_NOT_ALLOWED",
  REQUESTER_NOT_ALLOWED: "REQUESTER_NOT_ALLOWED",
  ATTEMPTS_LOCKED: "APPROVAL_ATTEMPTS_LOCKED",
  PASSWORD_RESET_REQUIRED: "PASSWORD_RESET_REQUIRED",
  APPROVAL_REQUIRED: "SALE_CHANGE_APPROVAL_REQUIRED",
});

/**
 * Why a stored approval did not cover a change. Returned beside `SALE_CHANGE_APPROVAL_REQUIRED`
 * as `detail`, so a support call can say which of the bindings failed without the UI having to
 * parse a message.
 */
const BINDING_DETAILS = Object.freeze({
  MISSING: "APPROVAL_MISSING",
  NOT_FOUND: "APPROVAL_NOT_FOUND",
  ALREADY_USED: "APPROVAL_ALREADY_USED",
  NOT_ISSUED: "APPROVAL_NOT_ISSUED",
  EXPIRED: "APPROVAL_EXPIRED",
  WRONG_ACTION: "APPROVAL_WRONG_ACTION",
  WRONG_SALE: "APPROVAL_WRONG_SALE",
  WRONG_REQUESTER: "APPROVAL_WRONG_REQUESTER",
  WRONG_COMPANY: "APPROVAL_WRONG_COMPANY",
  WRONG_DEVICE: "APPROVAL_WRONG_DEVICE",
  APPROVER_NO_LONGER_ALLOWED: "APPROVER_NO_LONGER_ALLOWED",
});

const text = (value) => (typeof value === "string" ? value.trim() : "");

/**
 * An id as an opaque string. Ids are never coerced to numbers: `"004"` and `4` are different
 * entities, and a numeric comparison would quietly make them the same one.
 */
const idText = (value) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  return typeof value === "string" ? value.trim() : "";
};

const sameId = (left, right) => {
  const a = idText(left);
  const b = idText(right);
  return a !== "" && a === b;
};

const roleName = (value) => text(value);

/** True when this role must get an Owner or Admin to approve a bill change. */
const approvalRequired = (role) => !APPROVER_ROLES.has(roleName(role));

/** True when this role may approve somebody else's bill change. */
const canApprove = (role) => APPROVER_ROLES.has(roleName(role));

const invalid = (message) => ({ ok: false, code: CODES.REQUEST_INVALID, message });

/**
 * Validate the approval request body.
 *
 * The password is taken exactly as typed -- never trimmed, since a space can be part of it -- and is
 * never echoed in any message this returns.
 *
 * @returns {{ok: true, value: {action, saleRef, approverUsername, approverPassword, reason}} |
 *           {ok: false, code: string, message: string}}
 */
const normalizeApprovalRequest = (body) => {
  const source = body && typeof body === "object" ? body : {};
  const action = text(source.action).toLowerCase();
  if (!APPROVAL_ACTIONS.includes(action)) return invalid("Say whether the bill is being cancelled or edited.");
  const saleRef = idText(source.sale_ref);
  if (!saleRef) return invalid("Say which bill needs approval.");
  if (saleRef.length > SALE_REF_MAX_LENGTH) return invalid("The bill reference is too long.");
  const approverUsername = text(source.approver_username);
  if (!approverUsername) return invalid("Enter the Owner or Admin username.");
  if (approverUsername.length > USERNAME_MAX_LENGTH) return invalid("That username is too long.");
  const approverPassword = typeof source.approver_password === "string" ? source.approver_password : "";
  if (!approverPassword) return invalid("Enter the Owner or Admin password.");
  if (approverPassword.length > PASSWORD_MAX_LENGTH) return invalid("That password is too long.");
  const reason = text(source.reason);
  if (!reason) return invalid("A reason is required.");
  if (reason.length > REASON_MAX_LENGTH) return invalid("The reason is too long.");
  return { ok: true, value: { action, saleRef, approverUsername, approverPassword, reason } };
};

/** An approval id as sent by a client, or "" when absent or not plausibly one. */
const normalizeApprovalId = (value) => {
  const id = text(value);
  return id && id.length <= APPROVAL_ID_MAX_LENGTH ? id : "";
};

const timeMs = (value) => {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  if (typeof value === "string" && value.trim()) return Date.parse(value);
  return Number.NaN;
};

const refuse = (detail, message) => ({ ok: false, code: CODES.APPROVAL_REQUIRED, detail, message });

const APPROVAL_NEEDED_MESSAGE = "Cancelling or editing this bill needs Owner or Admin approval.";

/**
 * Does this stored approval cover this change?
 *
 * Every check fails closed: a missing field on either side is a mismatch, never a wildcard. The
 * device is checked whenever the caller knows its device, which both paths do.
 *
 * `row.approver_role` / `row.approver_active` are the approver as they are *now*: an Admin demoted
 * after approving no longer covers a change made later.
 *
 * @returns {{ok: true} | {ok: false, code: string, detail: string, message: string}}
 */
const checkApprovalBinding = (row, { action, saleRefs, requesterId, companyId, deviceId, nowMs } = {}) => {
  if (!row) return refuse(BINDING_DETAILS.NOT_FOUND, `${APPROVAL_NEEDED_MESSAGE} The approval sent with it was not found.`);
  if (row.status === APPROVAL_STATUS.CONSUMED) {
    return refuse(BINDING_DETAILS.ALREADY_USED, `${APPROVAL_NEEDED_MESSAGE} That approval has already been used; ask again.`);
  }
  if (row.status !== APPROVAL_STATUS.ISSUED) {
    return refuse(BINDING_DETAILS.NOT_ISSUED, `${APPROVAL_NEEDED_MESSAGE} That approval was never granted.`);
  }
  const expiresAt = timeMs(row.expires_at);
  const now = Number.isFinite(nowMs) ? nowMs : Number.NaN;
  if (!Number.isFinite(expiresAt) || !Number.isFinite(now) || expiresAt <= now) {
    return refuse(BINDING_DETAILS.EXPIRED, `${APPROVAL_NEEDED_MESSAGE} That approval has expired; ask again.`);
  }
  if (text(row.action).toLowerCase() !== text(action).toLowerCase() || !APPROVAL_ACTIONS.includes(text(action).toLowerCase())) {
    return refuse(BINDING_DETAILS.WRONG_ACTION, `${APPROVAL_NEEDED_MESSAGE} That approval was for a different kind of change.`);
  }
  const refs = (Array.isArray(saleRefs) ? saleRefs : []).map(idText).filter(Boolean);
  if (!refs.some((ref) => sameId(ref, row.sale_ref))) {
    return refuse(BINDING_DETAILS.WRONG_SALE, `${APPROVAL_NEEDED_MESSAGE} That approval was for a different bill.`);
  }
  if (!sameId(row.requester_id, requesterId)) {
    return refuse(BINDING_DETAILS.WRONG_REQUESTER, `${APPROVAL_NEEDED_MESSAGE} That approval was given to someone else.`);
  }
  if (!sameId(row.company_id, companyId)) {
    return refuse(BINDING_DETAILS.WRONG_COMPANY, `${APPROVAL_NEEDED_MESSAGE} That approval belongs to a different company.`);
  }
  if (idText(deviceId) && !sameId(row.device_id, deviceId)) {
    return refuse(BINDING_DETAILS.WRONG_DEVICE, `${APPROVAL_NEEDED_MESSAGE} That approval was given on a different counter.`);
  }
  if (!canApprove(row.approver_role) || row.approver_active === false || !idText(row.approver_id)) {
    return refuse(
      BINDING_DETAILS.APPROVER_NO_LONGER_ALLOWED,
      `${APPROVAL_NEEDED_MESSAGE} The person who approved it is no longer an active Owner or Admin.`,
    );
  }
  return { ok: true };
};

/** The refusal for a change that arrived with no approval at all. */
const missingApproval = () => refuse(BINDING_DETAILS.MISSING, APPROVAL_NEEDED_MESSAGE);

/** Failures inside the window, from a list of failure times. */
const recentFailureCount = (failureTimes, nowMs) => {
  if (!Array.isArray(failureTimes) || !Number.isFinite(nowMs)) return 0;
  return failureTimes
    .map(timeMs)
    .filter((at) => Number.isFinite(at) && at > nowMs - FAILURE_WINDOW_MS && at <= nowMs)
    .length;
};

/**
 * True once a requester has used up their attempts. The attempt that would be the sixth is refused
 * before any password is compared, and is not itself recorded as a failure -- otherwise every
 * refused retry would push the window forward and the lock would never lift.
 */
const approvalAttemptsLocked = (recentFailures, dailyFailures = 0) => {
  const count = Number(recentFailures);
  const daily = Number(dailyFailures);
  return (Number.isFinite(count) && count >= FAILURE_LIMIT) || (Number.isFinite(daily) && daily >= DAILY_FAILURE_LIMIT);
};

/** True when the daily ceiling, not the short window, is what locked the requester. */
const approvalAttemptsLockedForTheDay = (dailyFailures) => {
  const daily = Number(dailyFailures);
  return Number.isFinite(daily) && daily >= DAILY_FAILURE_LIMIT;
};

const expiresAtFrom = (nowMs) => new Date(nowMs + APPROVAL_TTL_MS);

/** Every reference a client might use for this bill: the row id, its global id, its offline ref. */
const saleRefsOf = (sale) => (sale ? [sale.id, sale.global_id, sale.offline_invoice_ref].map(idText).filter(Boolean) : []);

module.exports = {
  APPROVAL_ACTIONS,
  APPROVAL_STATUS,
  APPROVAL_TTL_MS,
  APPROVER_ROLES,
  BINDING_DETAILS,
  CODES,
  FAILURE_LIMIT,
  FAILURE_WINDOW_MINUTES,
  FAILURE_WINDOW_MS,
  SALE_REF_MAX_LENGTH,
  approvalAttemptsLocked,
  approvalAttemptsLockedForTheDay,
  DAILY_FAILURE_LIMIT,
  approvalRequired,
  canApprove,
  checkApprovalBinding,
  expiresAtFrom,
  missingApproval,
  normalizeApprovalId,
  normalizeApprovalRequest,
  recentFailureCount,
  saleRefsOf,
};
