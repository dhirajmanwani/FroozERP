/**
 * Plain labels for the enum codes the app stores.
 *
 * Tables across the app print raw codes straight from the row: `BANK_TRANSFER`, `FIXED_AMOUNT`,
 * `CASH_REFUND`, `INVENTORY_LOT_ADJUST`. A shopkeeper should read "Bank transfer", not the column
 * value. This module is the one place that turns a code into words, so every table says the same
 * thing for the same code.
 *
 * Rules, each of which exists because the opposite would hide information:
 *
 *   - Lookup ignores case, surrounding spaces, and treats `-`, `_` and spaces as the same, so
 *     `bank transfer`, `Bank-Transfer` and `BANK_TRANSFER` all find one entry. Values that the
 *     backend already emits as words (`'Customer Payment' AS transaction_type`) find the same entry.
 *   - A code with no entry is never hidden and never blanked. It is turned into words from the code
 *     itself (`SOME_NEW_CODE` reads "Some new code"), so a value added to the backend later still
 *     shows up, legibly, instead of disappearing.
 *   - A missing value (null, undefined, empty or blank text) reads "—", never "" and never "0".
 *     An empty cell and a zero are different facts.
 *
 * Labels are sentence case ("Bank transfer", not "Bank Transfer"). Acronyms (UPI, POS) and proper
 * nouns (WhatsApp, iPhone, Android, Windows) keep their own spelling.
 *
 * Every value listed here was taken from the code that writes it: `backend/server.js` (the
 * `*_TYPES` sets, SQL literals and `AS transaction_type` strings), `src-tauri/src/local_db.rs`, the
 * SQLite migrations' CHECK constraints, and the `<option>` lists in App.jsx. None is invented.
 */

/** What a missing value reads as. An em dash, so it can never be mistaken for a zero. */
export const EMPTY_LABEL = "—";

/** Tones a status can carry. Mapped to CSS by the caller. */
export const DISPLAY_TONES = Object.freeze(["success", "warning", "danger", "neutral", "info"]);

/** Words that stay upper case when a label is built from an unknown code. */
export const LABEL_ACRONYMS = Object.freeze(["UPI", "GST", "POS", "QR", "PDF", "ID", "OTP", "SMS", "NEFT", "RTGS", "IMPS", "MRP", "HSN", "SKU", "INR", "AI", "API", "ERP", "OK"]);
const ACRONYM_SET = new Set(LABEL_ACRONYMS);

/**
 * Upper-case, trimmed, with every run of `-`, `_` or whitespace collapsed to one `_`.
 * Returns "" for a missing value.
 */
export const normalizeCode = (value) => {
  if (value === null || value === undefined) return "";
  return String(value)
    .trim()
    .toUpperCase()
    .replace(/[\s_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
};

const isMissing = (value) => value === null || value === undefined || String(value).trim() === "";

/**
 * Words for a code that has no entry.
 *
 * A value that already reads as text (mixed case, no underscores — "Desktop Browser - Chrome") is
 * returned as it is, because re-casing it would damage names inside it. Anything code-shaped is
 * split on `-`, `_` and spaces and sentence-cased, keeping known acronyms upper case.
 */
export const humanizeCode = (value) => {
  if (isMissing(value)) return EMPTY_LABEL;
  const text = String(value).trim().replace(/\s+/g, " ");
  const hasLower = /[a-z]/.test(text);
  const hasUpper = /[A-Z]/.test(text);
  if (hasLower && hasUpper && !text.includes("_")) return text;
  const words = text.split(/[\s_-]+/).filter(Boolean);
  if (words.length === 0) return text;
  return words
    .map((word, index) => {
      const upper = word.toUpperCase();
      if (ACRONYM_SET.has(upper)) return upper;
      const lower = word.toLowerCase();
      return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
    })
    .join(" ");
};

const freeze = (entries) => Object.freeze({ ...entries });

// ---------------------------------------------------------------------------------------------
// Money and parties
// ---------------------------------------------------------------------------------------------

/**
 * `payment_mode` on sales, sale payments, supplier/customer payments, expenses and discounts.
 * backend: SUPPLIER_PAYMENT_MODES, BANK_PAYMENT_MODES, DISCOUNT_PAYMENT_MODES, the POS
 * `allowedPaymentModes` set, `MIXED` for a split bill, `OTHER` from the account report filter.
 * `MULTIPLE` is written by App.jsx when clubbed rows carry different modes.
 */
export const PAYMENT_MODE_LABELS = freeze({
  CASH: "Cash",
  UPI: "UPI",
  CARD: "Card",
  BANK_TRANSFER: "Bank transfer",
  BANK: "Bank",
  CHEQUE: "Cheque",
  CREDIT: "Credit (pay later)",
  MIXED: "Mixed payment",
  OTHER: "Other",
  ALL: "All modes",
  MULTIPLE: "Multiple",
});

/**
 * `account_type` on accounts, ledgers and the account report; also `payment_source`
 * (CUSTOMER / SUPPLIER). backend ACCOUNT_TYPES plus the report's `'…' AS account_type` literals
 * and the CASH / BANK book filters.
 */
export const ACCOUNT_TYPE_LABELS = freeze({
  CUSTOMER: "Customer",
  SUPPLIER: "Supplier",
  TRANSPORT_VENDOR: "Transport vendor",
  COMMISSION_AGENT: "Commission agent",
  STAFF: "Staff",
  OTHER: "Other",
  EXPENSE: "Expense",
  EXPENSE_VENDOR: "Expense vendor",
  INVENTORY: "Stock",
  CONTRA: "Cash/bank transfer",
  CASH: "Cash",
  BANK: "Bank",
  SUMMARY: "Summary",
});

/** `supplier_type`. backend SUPPLIER_TYPES. */
export const SUPPLIER_TYPE_LABELS = freeze({
  LOCAL_SUPPLIER: "Local supplier",
  IMPORTED_SUPPLIER: "Imported goods supplier",
  COMMISSION_AGENT: "Commission agent",
  TRANSPORT_VENDOR: "Transport vendor",
});

/** `customer_type`. backend CUSTOMER_TYPES. */
export const CUSTOMER_TYPE_LABELS = freeze({
  RETAIL: "Retail",
  WHOLESALE: "Wholesale",
});

/**
 * Anything that names a kind of money or stock movement:
 *   - `stock_transactions.transaction_type` (IN / OUT) and the local `movement_type`
 *     (SALE_OUT / SALE_REVERSAL);
 *   - `customer_ledger.transaction_type` (SALE_CREDIT, SALE_EDIT_CREDIT, SALE_EDIT_DEBIT,
 *     SALE_CANCELLED);
 *   - the ledger / day-book / payment report strings the backend already writes as words
 *     (`transaction_type`, `voucher_type`, `payment_type`, `source`, `source_type`).
 * The word-form entries are here so those rows come out in the same sentence case as the rest.
 */
export const TRANSACTION_TYPE_LABELS = freeze({
  IN: "Stock in",
  OUT: "Stock out",
  SALE_OUT: "Sold",
  SALE_REVERSAL: "Sale reversed",
  SALE_CREDIT: "Credit sale",
  SALE_EDIT_CREDIT: "Sale edited (due reduced)",
  SALE_EDIT_DEBIT: "Sale edited (due increased)",
  SALE_CANCELLED: "Sale cancelled",
  OPENING_BALANCE: "Opening balance",
  OPENING_STOCK: "Opening stock",
  SALE: "Sale",
  SALES: "Sales",
  POS_SALE: "Counter sale",
  SALE_PAYMENT: "Payment at sale",
  SALE_CANCELLATION: "Sale cancelled",
  SALE_RETURN: "Sale return",
  SALE_RETURN_REFUND: "Sale return refund",
  CUSTOMER_SALE: "Customer sale",
  CUSTOMER_SALE_CANCELLATION: "Customer sale cancelled",
  CUSTOMER_PAYMENT: "Customer payment",
  CUSTOMER_RECEIPT: "Customer payment",
  RECEIPT: "Payment received",
  PAYMENT: "Payment",
  PURCHASE: "Purchase",
  PURCHASE_CANCELLATION: "Purchase cancelled",
  PURCHASE_PAYMENT: "Purchase payment",
  SUPPLIER_PURCHASE: "Supplier purchase",
  SUPPLIER_PURCHASE_CANCELLATION: "Supplier purchase cancelled",
  SUPPLIER_PAYMENT: "Supplier payment",
  SUPPLIER_REBATE: "Supplier rebate",
  REBATE: "Rebate",
  EXPENSE: "Expense",
  WASTE: "Waste",
  CONTRA_PAYMENT: "Cash/bank transfer out",
  CONTRA_RECEIPT: "Cash/bank transfer in",
  CASH_BOOK_DATE_SUMMARY: "Day summary",
});

/** `discount_type` on bill discounts (FLAT_AMOUNT, PERCENTAGE) and lot discounts (FIXED_AMOUNT, PERCENTAGE, SPECIAL_RATE). */
export const DISCOUNT_TYPE_LABELS = freeze({
  FLAT_AMOUNT: "Flat amount",
  FIXED_AMOUNT: "Fixed amount",
  PERCENTAGE: "Percentage",
  SPECIAL_RATE: "Special rate",
});

/** `refund_type` on sale returns. backend REFUND_TYPES. */
export const REFUND_TYPE_LABELS = freeze({
  CASH_REFUND: "Cash refund",
  UPI_REFUND: "UPI refund",
  CREDIT_NOTE: "Credit note",
  FUTURE_ADJUSTMENT: "Adjust in next sale",
});

// ---------------------------------------------------------------------------------------------
// Products and stock
// ---------------------------------------------------------------------------------------------

/** `unit` on products and lots. backend PRODUCT_UNITS. */
export const UNIT_LABELS = freeze({
  KG: "Kg",
  BOX: "Box",
  PIECE: "Piece",
  DOZEN: "Dozen",
});

/** `origin_type` on products, purchase lines, mandi-tax rules and sale rates. */
export const ORIGIN_LABELS = freeze({
  LOCAL: "Local",
  IMPORTED: "Imported",
});

/** `waste_type`. backend WASTE_TYPES. Daagi is the shop's own word for spotted/damaged fruit. */
export const WASTE_TYPE_LABELS = freeze({
  DAAGI: "Daagi (damaged)",
  SAMPLING: "Sampling",
  PERSONAL_USE: "Personal use",
  OTHER: "Other",
});

/** `stock_source` on lots. PURCHASE is the column default; OPENING_STOCK is written by the opening-stock route. */
export const STOCK_SOURCE_LABELS = freeze({
  PURCHASE: "Purchase",
  OPENING_STOCK: "Opening stock",
});

/**
 * `adjustment_type` on lot adjustments. Stored as the text of the App.jsx `<option>` list
 * ("Physical Count Correction" is also the backend default), so it normalises to these keys.
 */
export const ADJUSTMENT_TYPE_LABELS = freeze({
  INCREASE_STOCK: "Increase stock",
  DECREASE_STOCK: "Decrease stock",
  PHYSICAL_COUNT_CORRECTION: "Stock count correction",
  DAMAGE: "Damage",
  MISSING: "Missing",
  FOUND: "Found",
  OWNER_ADJUSTMENT: "Owner adjustment",
});

/**
 * `action` on the audit trails: product, category, lot (stock audit), purchase, sale, payment,
 * expense and device. Values from every `INSERT INTO *_audit*` in backend/server.js and the local
 * sale audit log in local_db.rs.
 */
export const AUDIT_ACTION_LABELS = freeze({
  CREATE: "Created",
  EDIT: "Edited",
  CANCEL: "Cancelled",
  DELETE: "Deleted",
  DEACTIVATE: "Deactivated",
  ARCHIVE_DUPLICATE: "Duplicate archived",
  PRODUCT_PHOTO_SET: "Photo added",
  PRODUCT_PHOTO_REMOVED: "Photo removed",
  OPENING_STOCK: "Opening stock",
  OPENING_STOCK_LOT_ADDED: "Opening stock lot added",
  INVENTORY_LOT_EDIT: "Lot edited",
  INVENTORY_LOT_ADD_QTY: "Quantity added",
  INVENTORY_LOT_ADJUST: "Stock adjusted",
  INVENTORY_LOT_DEACTIVATE: "Lot deactivated",
  INVENTORY_LOT_REACTIVATE: "Lot reactivated",
  INVENTORY_LOT_TRANSFER_OUT: "Moved out",
  INVENTORY_LOT_TRANSFER_IN: "Moved in",
  ADDED_ITEMS: "Items added",
  COMPLETE_BILL: "Bill completed",
  EDIT_PENDING_ARRIVAL: "Pending arrival edited",
  APPROVE: "Approved",
  REJECT: "Rejected",
  DISABLE: "Disabled",
  RENAME: "Renamed",
});

// ---------------------------------------------------------------------------------------------
// Statuses (each has a tone map below)
// ---------------------------------------------------------------------------------------------

/**
 * Generic record state: `sale_status` (COMPLETED / EDITED / CANCELLED), `purchase_status`
 * (ACTIVE / EDITED / CANCELLED), `expenses.status` (ACTIVE / CANCELLED), and an `active` flag
 * (true / false are accepted and read as Active / Inactive).
 */
export const RECORD_STATUS_LABELS = freeze({
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  COMPLETED: "Completed",
  EDITED: "Edited",
  CANCELLED: "Cancelled",
});

/** `batch_status` on lots. ACTIVE / CANCELLED are written; the rest are refused by the sale path. */
export const BATCH_STATUS_LABELS = freeze({
  ACTIVE: "Active",
  INACTIVE: "Inactive",
  CANCELLED: "Cancelled",
  EXPIRED: "Expired",
  RESERVED: "Reserved",
  BLOCKED: "Blocked",
  EXHAUSTED: "Sold out",
});

/** `purchase_bill_status`. backend PURCHASE_BILL_STATUSES. */
export const PURCHASE_BILL_STATUS_LABELS = freeze({
  BILL_PENDING: "Bill pending",
  BILL_COMPLETED: "Bill complete",
});

/**
 * How much of a bill is paid: `credit_status` on credit invoices ("Paid" / "Partially Paid" /
 * "Pending", written as words) and `purchases.payment_status` (PENDING default).
 */
export const PAYMENT_STATUS_LABELS = freeze({
  PAID: "Paid",
  PARTIALLY_PAID: "Partly paid",
  PENDING: "Pending",
  UNPAID: "Not paid",
});

/** `customer_orders.status`. SQLite migration 020 CHECK; ORDER_STATUS in orderLifecycle.js. */
export const ORDER_STATUS_LABELS = freeze({
  RECEIVED: "Received",
  PACKED: "Packed",
  SENT: "Sent",
  DELIVERED: "Delivered",
  CANCELLED: "Cancelled",
  RETURNED: "Returned",
});

/** `customer_orders.source`. SQLite migration 020 CHECK. */
export const ORDER_SOURCE_LABELS = freeze({
  PHONE: "Phone",
  WHATSAPP: "WhatsApp",
  WEBSITE: "Website",
  COUNTER: "Counter",
  OTHER: "Other",
});

/** `customer_orders.payment_state`. SQLite migration 021 CHECK; PAYMENT_STATE in orderLifecycle.js. */
export const ORDER_PAYMENT_STATE_LABELS = freeze({
  PAID: "Paid",
  ON_DELIVERY: "Pay on delivery",
  UNPAID: "Not paid",
});

/** `authorized_devices.status`. PENDING default, APPROVED, REJECTED / DISABLED from the device action route; NOT_REGISTERED from the device-status check. */
export const DEVICE_STATUS_LABELS = freeze({
  PENDING: "Waiting for approval",
  APPROVED: "Approved",
  REJECTED: "Rejected",
  DISABLED: "Disabled",
  NOT_REGISTERED: "Not registered",
});

/** `activation_codes.status`: ACTIVE default, USED when redeemed, REVOKED by the Owner. */
export const ACTIVATION_CODE_STATUS_LABELS = freeze({
  ACTIVE: "Not used yet",
  USED: "Used",
  REVOKED: "Revoked",
});

/** `backup_logs.status`. */
export const BACKUP_STATUS_LABELS = freeze({
  RUNNING: "Running",
  SUCCESS: "Done",
  FAILED: "Failed",
});

/** `sync_status` / `state` on local work waiting for the cloud (offline purchases, customer orders). */
export const SYNC_STATUS_LABELS = freeze({
  PENDING: "Waiting to sync",
  SYNCING: "Syncing",
  COMPLETED: "Synced",
  SYNCED: "Synced",
  FAILED: "Sync failed",
  CONFLICT: "Needs review",
  BLOCKED: "Blocked",
});

/** Per-number WhatsApp send result (`sent` / `failed`). */
export const MESSAGE_STATUS_LABELS = freeze({
  SENT: "Sent",
  FAILED: "Failed",
});

// ---------------------------------------------------------------------------------------------
// Setup: branches, counters, devices, backups
// ---------------------------------------------------------------------------------------------

/** `operational_locations.location_type`. Matches the existing `locationTypeLabel` in App.jsx. */
export const LOCATION_TYPE_LABELS = freeze({
  STORE: "Shop counter",
  WAREHOUSE: "Store room / warehouse",
  MANDI_COUNTER: "Mandi counter",
  OFFICE: "Office",
});

/** `counters.counter_type`. */
export const COUNTER_TYPE_LABELS = freeze({
  RETAIL_COUNTER: "Retail counter",
  OWNER_DASHBOARD: "Owner dashboard",
  BACK_OFFICE: "Back office",
});

/**
 * `device_type` / `platform` on devices: the approval form's kinds, the backend defaults
 * ('Browser', 'Desktop'), and the shell platforms from local_db.rs / mobileGateway.js.
 */
export const DEVICE_TYPE_LABELS = freeze({
  LAPTOP: "Laptop",
  DESKTOP: "Desktop",
  TABLET: "Tablet",
  ANDROID_PHONE: "Android phone",
  IPHONE: "iPhone",
  OTHER: "Other",
  BROWSER: "Browser",
  TAURI_WINDOWS: "Windows app",
  TAURI_ANDROID: "Android app",
  TAURI_IOS: "iPhone app",
});

/** `intended_usage` on device assignments. */
export const DEVICE_USAGE_LABELS = freeze({
  POS: "Billing (POS)",
  PURCHASE_ENTRY: "Purchase entry",
  INVENTORY: "Inventory",
  ACCOUNTS: "Accounts",
  REPORTS: "Reports",
  OWNER_DASHBOARD: "Owner dashboard",
});

/** `backup_logs.backup_type`: 'Manual', 'Scheduled', 'Shutdown'. */
export const BACKUP_TYPE_LABELS = freeze({
  MANUAL: "Manual",
  SCHEDULED: "Scheduled",
  SHUTDOWN: "On shutdown",
});

// ---------------------------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------------------------

const FAMILY_MAPS = {
  paymentMode: PAYMENT_MODE_LABELS,
  accountType: ACCOUNT_TYPE_LABELS,
  supplierType: SUPPLIER_TYPE_LABELS,
  customerType: CUSTOMER_TYPE_LABELS,
  transactionType: TRANSACTION_TYPE_LABELS,
  discountType: DISCOUNT_TYPE_LABELS,
  refundType: REFUND_TYPE_LABELS,
  unit: UNIT_LABELS,
  origin: ORIGIN_LABELS,
  wasteType: WASTE_TYPE_LABELS,
  stockSource: STOCK_SOURCE_LABELS,
  adjustmentType: ADJUSTMENT_TYPE_LABELS,
  auditAction: AUDIT_ACTION_LABELS,
  recordStatus: RECORD_STATUS_LABELS,
  batchStatus: BATCH_STATUS_LABELS,
  purchaseBillStatus: PURCHASE_BILL_STATUS_LABELS,
  paymentStatus: PAYMENT_STATUS_LABELS,
  orderStatus: ORDER_STATUS_LABELS,
  orderSource: ORDER_SOURCE_LABELS,
  orderPaymentState: ORDER_PAYMENT_STATE_LABELS,
  deviceStatus: DEVICE_STATUS_LABELS,
  activationCodeStatus: ACTIVATION_CODE_STATUS_LABELS,
  backupStatus: BACKUP_STATUS_LABELS,
  syncStatus: SYNC_STATUS_LABELS,
  messageStatus: MESSAGE_STATUS_LABELS,
  locationType: LOCATION_TYPE_LABELS,
  counterType: COUNTER_TYPE_LABELS,
  deviceType: DEVICE_TYPE_LABELS,
  deviceUsage: DEVICE_USAGE_LABELS,
  backupType: BACKUP_TYPE_LABELS,
};

/** Every family name `labelFor` / `toneFor` know, in a fixed order. */
export const DISPLAY_LABEL_FAMILIES = Object.freeze(Object.keys(FAMILY_MAPS));

/** Family name -> its frozen label map. */
export const DISPLAY_LABEL_MAPS = Object.freeze({ ...FAMILY_MAPS });

/**
 * Column names that mean a family, so a caller can pass the field it is printing
 * (`labelFor("payment_mode", row.payment_mode)`, `labelFor("origin_type", …)`).
 * Only unambiguous names are listed; `status` and `type` alone are not, because they mean
 * different things on different tables.
 */
export const DISPLAY_LABEL_FAMILY_ALIASES = Object.freeze({
  payment_source: "accountType",
  origin_type: "origin",
  voucher_type: "transactionType",
  payment_type: "transactionType",
  source_type: "transactionType",
  movement_type: "transactionType",
  action: "auditAction",
  sale_status: "recordStatus",
  purchase_status: "recordStatus",
  active: "recordStatus",
  credit_status: "paymentStatus",
  payment_state: "orderPaymentState",
  intended_usage: "deviceUsage",
  requested_intended_usage: "deviceUsage",
  platform: "deviceType",
  sync_state: "syncStatus",
});

const familyKey = (family) => String(family ?? "").replace(/[\s_-]+/g, "").toLowerCase();
const FAMILY_LOOKUP = new Map();
for (const name of DISPLAY_LABEL_FAMILIES) FAMILY_LOOKUP.set(familyKey(name), name);
for (const [alias, name] of Object.entries(DISPLAY_LABEL_FAMILY_ALIASES)) FAMILY_LOOKUP.set(familyKey(alias), name);

/**
 * The canonical family name for `family` (case and separators ignored; column-name aliases
 * accepted), or "" when it is not a known family.
 */
export const resolveFamily = (family) => FAMILY_LOOKUP.get(familyKey(family)) || "";

/** Per-family spellings that mean an existing key. Only for spellings that really occur. */
const VALUE_ALIASES = {
  recordStatus: { TRUE: "ACTIVE", FALSE: "INACTIVE" },
};

const lookupKey = (family, value) => {
  const code = normalizeCode(value);
  return VALUE_ALIASES[family]?.[code] || code;
};

/**
 * A readable label for `value` in `family`.
 *
 * Never returns "" and never returns "0" for a missing value: missing reads "—", and a code with
 * no entry (or an unknown family) is turned into words from the code itself.
 */
export const labelFor = (family, value) => {
  if (isMissing(value)) return EMPTY_LABEL;
  const name = resolveFamily(family);
  const map = name ? FAMILY_MAPS[name] : null;
  if (map) {
    const key = lookupKey(name, value);
    if (Object.prototype.hasOwnProperty.call(map, key)) return map[key];
  }
  return humanizeCode(value);
};

// ---------------------------------------------------------------------------------------------
// Tones
// ---------------------------------------------------------------------------------------------

const S = "success";
const W = "warning";
const D = "danger";
const I = "info";
const N = "neutral";

export const RECORD_STATUS_TONES = freeze({ ACTIVE: S, COMPLETED: S, EDITED: I, INACTIVE: D, CANCELLED: D });
export const BATCH_STATUS_TONES = freeze({ ACTIVE: S, RESERVED: I, EXHAUSTED: W, INACTIVE: D, CANCELLED: D, EXPIRED: D, BLOCKED: D });
export const PURCHASE_BILL_STATUS_TONES = freeze({ BILL_COMPLETED: S, BILL_PENDING: W });
export const PAYMENT_STATUS_TONES = freeze({ PAID: S, PARTIALLY_PAID: W, PENDING: W, UNPAID: W });
export const ORDER_STATUS_TONES = freeze({ RECEIVED: W, PACKED: I, SENT: I, DELIVERED: S, RETURNED: W, CANCELLED: D });
export const ORDER_PAYMENT_STATE_TONES = freeze({ PAID: S, ON_DELIVERY: I, UNPAID: W });
export const DEVICE_STATUS_TONES = freeze({ APPROVED: S, PENDING: W, REJECTED: D, DISABLED: D, NOT_REGISTERED: N });
export const ACTIVATION_CODE_STATUS_TONES = freeze({ ACTIVE: S, USED: N, REVOKED: D });
export const BACKUP_STATUS_TONES = freeze({ SUCCESS: S, RUNNING: I, FAILED: D });
export const SYNC_STATUS_TONES = freeze({ COMPLETED: S, SYNCED: S, SYNCING: I, PENDING: W, FAILED: D, CONFLICT: D, BLOCKED: D });
export const MESSAGE_STATUS_TONES = freeze({ SENT: S, FAILED: D });

const TONE_MAPS = {
  recordStatus: RECORD_STATUS_TONES,
  batchStatus: BATCH_STATUS_TONES,
  purchaseBillStatus: PURCHASE_BILL_STATUS_TONES,
  paymentStatus: PAYMENT_STATUS_TONES,
  orderStatus: ORDER_STATUS_TONES,
  orderPaymentState: ORDER_PAYMENT_STATE_TONES,
  deviceStatus: DEVICE_STATUS_TONES,
  activationCodeStatus: ACTIVATION_CODE_STATUS_TONES,
  backupStatus: BACKUP_STATUS_TONES,
  syncStatus: SYNC_STATUS_TONES,
  messageStatus: MESSAGE_STATUS_TONES,
};

/** Families that carry a tone. Every other family is always "neutral". */
export const STATUS_TONE_FAMILIES = Object.freeze(Object.keys(TONE_MAPS));

/**
 * "success" | "warning" | "danger" | "neutral" | "info" for `value` in `family`.
 * Non-status families, unknown codes and missing values are "neutral": a tone is only claimed
 * when the code is known to mean it.
 */
export const toneFor = (family, value) => {
  if (isMissing(value)) return N;
  const name = resolveFamily(family);
  const map = name ? TONE_MAPS[name] : null;
  if (!map) return N;
  const key = lookupKey(name, value);
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : N;
};
