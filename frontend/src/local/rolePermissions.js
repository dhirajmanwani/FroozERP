/**
 * What a role may open and do, decided from the role's stored permission map.
 *
 * ## Why this exists
 *
 * Settings -> Role Permissions saves a map per role (`{ purchases: true, billing: false, ... }`).
 * The screens used to decide access from role *names* or from built-in defaults checked before the
 * stored map, so unticking a screen for a role changed nothing: `hasModuleAccess` returned true from
 * `defaultRolePermissions` first, and the payment screens asked "is this a Cashier?" instead of
 * "may this role take customer payments?".
 *
 * ## Rules this module keeps
 *
 * 1. **Owner is always allowed** — the server (`getPermissionUser`) does the same.
 * 2. **A stored key wins.** If the role's map defines the key, its value is the answer, true or
 *    false. Built-in defaults only answer a key the map does not define, exactly as the server's
 *    `storedPermission === undefined && roleMatches(defaultRoles)` does.
 * 3. **Nothing here is the security boundary.** The server refuses regardless; this decides what is
 *    drawn, so a person is not handed a button that can only fail.
 */

const roleKey = (role) => String(role ?? "").trim().toUpperCase();

export const isOwnerRole = (role) => roleKey(role) === "OWNER";

const defines = (permissions, key) => Boolean(
  permissions && typeof permissions === "object" && Object.prototype.hasOwnProperty.call(permissions, key),
);

/**
 * One permission key, mirroring the server's `getPermissionUser(userId, key, defaultRoles)`.
 * `defaultRoles` answers only when the stored map does not define the key.
 */
export const roleGrants = ({ role, permissions, key, defaultRoles = ["Owner", "Admin"] } = {}) => {
  if (isOwnerRole(role)) return true;
  if (defines(permissions, key)) return permissions[key] === true;
  return defaultRoles.some((candidate) => roleKey(candidate) === roleKey(role));
};

// Screens reached through more than one key. Accounts is the payments and master screen, so any
// of the money keys opens it; Pending Bills holds supplier bills (purchases) and customer credit
// (billing) side by side, so either half opens it.
const MULTI_KEY_VIEWS = Object.freeze({
  accounts: ["customer_payments", "supplier_payments", "supplier_accounts"],
  "pending-bills": ["billing", "purchases"],
});

// Screens whose reads the server allows the Owner and nobody else.
export const OWNER_ONLY_VIEWS = Object.freeze(["all-shops"]);

/**
 * Branches & Counters, by role.
 *
 * Most of the page is the Owner's: it reads /api/v3/admin/scope-management, refused with
 * ASSIGNMENT_ADMIN_REQUIRED for anyone else (backend/scopeManagement.js, `requireAssignmentOwner`).
 * Opened as an Admin it showed a 403 over a page of locked, empty boxes. But the Counter screen lock
 * on the same page is Owner *or* Admin (`PUT /settings/device-control`, `requireRateManager`), and an
 * Admin must be able to reset a forgotten exit code. So an Admin gets the page with that one
 * section and no scope read; the Owner gets everything; nobody else gets the page.
 */
export const BRANCHES_ADMIN_SECTIONS = Object.freeze(["branches/screen-lock"]);

export const branchesScreenPlan = (role) => {
  const owner = isOwnerRole(role);
  const admin = roleKey(role) === "ADMIN";
  return {
    open: owner || admin,
    readsScope: owner,
    showsSection: (sectionId) => owner || (admin && BRANCHES_ADMIN_SECTIONS.includes(sectionId)),
  };
};

/**
 * May this role open `view`. `defaultPermissions` is the role's built-in default
 * (`defaultRolePermissions[role]`), consulted only for keys the stored map leaves undefined.
 */
export const resolveModuleAccess = ({
  view,
  role,
  permissions = null,
  defaultPermissions = {},
  modulePermissionMap = {},
} = {}) => {
  if (OWNER_ONLY_VIEWS.includes(view)) return isOwnerRole(role);
  if (view === "branches") return branchesScreenPlan(role).open;
  if (isOwnerRole(role)) return true;
  if (view === "dashboard") {
    if (defines(permissions, "dashboard")) return permissions.dashboard === true;
    return roleKey(role) === "ADMIN";
  }
  const keys = MULTI_KEY_VIEWS[view] || (modulePermissionMap[view] ? [modulePermissionMap[view]] : []);
  const storedKeys = keys.filter((key) => defines(permissions, key));
  if (storedKeys.length > 0) return storedKeys.some((key) => permissions[key] === true);
  const defaults = defaultPermissions || {};
  return Boolean(defaults.all || defaults[view]);
};

/** The four account authorities, as the server checks them (default roles Owner and Admin). */
export const resolveAccountPermissions = ({ role, permissions } = {}) => ({
  customerPayments: roleGrants({ role, permissions, key: "customer_payments" }),
  supplierPayments: roleGrants({ role, permissions, key: "supplier_payments" }),
  customerAccounts: roleGrants({ role, permissions, key: "customer_accounts" }),
  supplierAccounts: roleGrants({ role, permissions, key: "supplier_accounts" }),
});

/**
 * Completing, editing or cancelling a pending purchase bill. The server allows Owner and Admin
 * only (`requireRateManager` on complete-bill, update and cancel), whatever the role map says.
 */
export const canManagePendingPurchaseBills = (role) => ["OWNER", "ADMIN"].includes(roleKey(role));

export const PENDING_BILL_MANAGER_NOTE = "Only the Owner or an Admin can complete, edit or cancel a pending bill.";

/**
 * Account types this person may create or edit in Account Master. A customer account needs
 * `customer_accounts`; every other type needs `supplier_accounts` (server: the account's type
 * decides the key).
 */
export const accountMasterTypeOptions = (accountTypes = [], permissions = {}) => accountTypes.filter(([value]) => (
  value === "CUSTOMER" ? permissions.customerAccounts === true : permissions.supplierAccounts === true
));

/** The type a new account starts as: Customer when allowed, else the first type allowed. */
export const defaultAccountMasterType = (accountTypes = [], permissions = {}) => {
  const options = accountMasterTypeOptions(accountTypes, permissions);
  if (options.some(([value]) => value === "CUSTOMER")) return "CUSTOMER";
  if (options.some(([value]) => value === "SUPPLIER")) return "SUPPLIER";
  return options[0]?.[0] || "SUPPLIER";
};

export const canEditAccountRow = (account, permissions = {}) => {
  if (!account || account.system_account === true) return false;
  return account.account_type === "CUSTOMER" ? permissions.customerAccounts === true : permissions.supplierAccounts === true;
};

/**
 * Whether to ask for Report Center's data at all. The report reads answer 403
 * REPORTS_PERMISSION_REQUIRED unless the caller is Owner or Admin or holds `reports`
 * (`denyWithoutReportsPermission` in backend/server.js). `loadReports` runs after every sale and on
 * opening POS, so a Cashier without Reports used to see "report request(s) failed" all day.
 *
 * A role map that has not loaded yet is not a "no": the request is made and the server decides.
 */
export const mayReadReports = ({ role, permissions } = {}) => {
  if (isOwnerRole(role) || roleKey(role) === "ADMIN") return true;
  if (!permissions || typeof permissions !== "object") return true;
  return permissions.reports === true;
};
