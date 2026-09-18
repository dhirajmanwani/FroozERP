"use strict";

/**
 * A-7 — who appears in the staff list, and which shop's staff that is.
 *
 * ## The hole this closes
 *
 * Two routes hand back the users table, and until now both handed back *all* of it:
 *
 * - `GET /users`, the administration screen's own read, which carries `recovery_email`,
 *   `recovery_mobile` and `locked_until` alongside the ordinary fields.
 * - `getSettingsBundle`, which the app actually calls on every settings load and which puts the
 *   same rows on screen without the recovery fields.
 *
 * Both were gated on role alone: `requireRateManager` admits Owner **and Admin**, so an Admin of
 * one shop could read every shop's staff — their names, usernames, mobiles, emails, and on
 * `GET /users` the very fields an account is recovered with. A branch that cannot see another
 * branch's sales could see the people who make them, which is the same tenancy boundary drawn in
 * a different place.
 *
 * ## The rule
 *
 * The Owner sees every branch, because the business is theirs. Anyone else who may open the list
 * at all sees their own branch and no other.
 *
 * ## Two decisions worth keeping written down
 *
 * **The role comes from the database, the branch from the token.** `requireRateManager` already
 * resolves the caller's role with a live query, so a token minted before a demotion cannot widen
 * the list; deciding "is this the Owner" from `req.auth.normalizedRole` would hand that back. The
 * branch is the opposite case: it is pinned into the session at login and verified on every
 * request, and there is no request field that may be trusted to name it instead.
 *
 * **Company scoping is deliberately not used.** `users.company_id` exists but is NULL on every
 * row — `POST /users` has never written it and the backfill was ruled out — so a
 * `WHERE u.company_id = $1` here would return zero users to everybody, including the Owner. An
 * empty staff list is not a safe failure: it reads as "this shop has no staff" rather than as a
 * fault, which is precisely the failure mode CLAUDE.md's "errors must never render as zero" rule
 * exists to forbid. `users.branch_id` is written on every row `POST /users` creates, so it is the
 * column that can carry this.
 *
 * A session that carries no usable branch is refused rather than widened. There is no default that
 * is both safe and useful: picking a branch shows one shop's staff to someone we could not place,
 * and showing everything is the bug.
 */

const OWNER_ROLE = "OWNER";

const normalizeRoleName = (value) => String(value || "").trim().toUpperCase().replace(/\s+/g, "_");

const positiveInteger = (value) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

/** Thrown, never returned as an empty result, so a caller cannot mistake it for "no staff". */
const branchScopeRequired = () => {
  const error = new Error("This session is not tied to a branch, so the staff list cannot be shown.");
  error.code = "USER_DIRECTORY_BRANCH_REQUIRED";
  error.status = 403;
  return error;
};

/**
 * Resolve how much of the users table this caller may read.
 *
 * `roleName` must be the role the database reports for the caller (`requireRateManager(...)`'s
 * `role_name`), not a token claim. `branchId` must be `req.auth.branchId`.
 */
const resolveUserDirectoryScope = ({ roleName, branchId } = {}) => {
  if (normalizeRoleName(roleName) === OWNER_ROLE) return { everyBranch: true, branchId: null };
  const branch = positiveInteger(branchId);
  if (!branch) throw branchScopeRequired();
  return { everyBranch: false, branchId: branch };
};

/**
 * The `WHERE` fragment and the values that go with it.
 *
 * Both query builders below go through this, so the administration screen's list and the settings
 * bundle's list cannot drift apart on who they include. A summary and a detail view derived from
 * different filters is the disagreement CLAUDE.md warns about; here it would show as a staff count
 * that does not match the staff.
 */
const userDirectoryFilter = (scope) => (scope.everyBranch
  ? { clause: "", values: [] }
  : { clause: "WHERE u.branch_id = $1", values: [scope.branchId] });

/** `GET /users` — the administration screen's read, recovery and lockout fields included. */
const buildUserDirectoryQuery = (scope) => {
  const { clause, values } = userDirectoryFilter(scope);
  return {
    text: `
      SELECT
        u.id, u.full_name, u.username, u.mobile_number, u.email, u.active,
        u.joining_date, u.notes, u.last_login_at, u.created_at, u.updated_at,
        u.verified_email, u.verified_mobile, u.recovery_enabled,
        u.recovery_email, u.recovery_email_verified, u.recovery_email_verified_at,
        u.recovery_mobile, u.recovery_mobile_verified, u.recovery_mobile_verified_at,
        u.pending_recovery_email, u.pending_recovery_mobile,
        u.staff_self_recovery_enabled, u.force_password_change,
        u.session_revocation_version, u.locked_until,
        r.role_name AS role, b.branch_name AS branch
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN branches b ON b.id = u.branch_id
      ${clause}
      ORDER BY u.active DESC, u.full_name
    `,
    values,
  };
};

/** The settings bundle's slice of the same list: no recovery fields, same population. */
const buildSettingsUserListQuery = (scope) => {
  const { clause, values } = userDirectoryFilter(scope);
  return {
    text: `
      SELECT
        u.id, u.full_name, u.username, u.mobile_number, u.email, u.active,
        u.joining_date, u.notes, u.last_login_at, u.created_at, u.updated_at,
        r.role_name AS role, b.branch_name AS branch
      FROM users u
      LEFT JOIN roles r ON r.id = u.role_id
      LEFT JOIN branches b ON b.id = u.branch_id
      ${clause}
      ORDER BY u.active DESC, u.full_name
    `,
    values,
  };
};

module.exports = {
  resolveUserDirectoryScope,
  userDirectoryFilter,
  buildUserDirectoryQuery,
  buildSettingsUserListQuery,
};
