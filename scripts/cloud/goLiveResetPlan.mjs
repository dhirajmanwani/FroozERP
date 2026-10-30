/**
 * What the go-live reset keeps, what it clears, and the SQL it is allowed to run.
 *
 * The owner's decision (30 Oct 2026): **keep the masters, clear the test transactions.** This file
 * is that decision written down table by table, so that it can be read, tested and argued with
 * before anything touches the cloud. `go-live-reset.mjs` is only the command that carries it out.
 *
 * ## The four buckets
 *
 *   KEEP           masters, settings, devices, licences, and the sync replay guards.
 *   CLEAR          test transactions and everything derived from them. Emptied with one
 *                  TRUNCATE ... CONTINUE IDENTITY, never with a cascade.
 *   OWNER_DECIDES  logs and FROST memory the owner may want to keep. Kept unless named in
 *                  `--also-clear`, and always printed separately so the choice is visible.
 *   PRUNE          `sync_change_log` only: rows of a transaction entity type are deleted, master
 *                  rows stay, and the change_id sequence is never touched.
 *
 * A table that exists in the database but is in none of them stops `--apply`. A new table is a new
 * question, and the answer has to be written here, not guessed by the command.
 *
 * ## Why there is no cascade, anywhere
 *
 * TRUNCATE with a cascade empties every table that points at a listed one. One wrong name in the
 * list -- or one master table that grew a foreign key into a transaction table -- and it empties
 * products or customers on the same run that claims to keep them. Without it, PostgreSQL refuses
 * the whole statement instead, which is the failure this file wants.
 *
 * ## Why CONTINUE IDENTITY
 *
 * It is PostgreSQL's default, and it is written out so nobody "tidies" it into a restart. Every
 * sequence keeps counting:
 *   - `sales.id` is the bill number (FZ-YYYYMMDD-<sales.id>). A restart would re-issue numbers
 *     already printed on test bills.
 *   - `inventory_batches.id` is how a stale bill finds its lot. A restart would hand a new lot the
 *     number of an old one.
 *   - `sync_change_log.change_id` is every device's cursor (`change_id > cursor`). That table is
 *     pruned with DELETE, not truncated, so its sequence is not even in reach.
 */

/** Masters, settings, devices and replay guards. Never written to by the reset. */
export const KEEP = Object.freeze({
  // Organisation and places
  companies: "company master",
  branches: "branch master",
  counters: "counter master",
  operational_locations: "v3 location master (counter/godown a device stands at)",
  operational_location_products: "per-location product settings (enabled, POS availability, rate override, reorder level) -- configuration, no quantities",
  staff_location_assignments: "which staff work at which location",

  // People and permissions
  users: "staff accounts",
  roles: "roles",
  role_permission_settings: "permissions per role",
  sale_permission_settings: "edit/cancel permissions per role",

  // Devices and licences -- deleting these is how a counter loses its licence
  authorized_devices: "approved devices; last_sync_at/sync_status are telemetry the next sync overwrites",
  device_assignments: "device -> location assignment; assignment_generation must not move",
  device_control_settings: "kiosk lock and unattended-update settings",
  activation_codes: "activation codes",
  activation_licences: "every issued .lic and its serial; the serial sequence must not move",
  sync_device_configuration: "per-device sync configuration",

  // Products and prices
  products: "product master; carries no stock column (stock is computed from inventory_batches)",
  product_categories: "category master",
  product_photos: "product photos",
  product_category_audit_trail: "history of category edits; every row describes a category that is kept",
  product_duplicate_archive_log: "why an archived duplicate product points at the product kept in its place",
  operational_scope_audit: "history of branch/location/assignment edits; all of it about kept masters",

  // Parties -- balances are computed from opening_balance + transactions, nothing is cached
  suppliers: "supplier master incl. opening balance",
  customers: "customer master incl. opening balance and the Walk-in system account",
  accounts: "other ledger accounts incl. opening balance",

  // Settings
  business_settings: "business settings",
  pos_settings: "POS settings",
  payment_settings: "payment settings",
  whatsapp_settings: "WhatsApp settings",
  backup_settings: "backup settings",
  sync_settings: "sync settings; pending_count is recomputed from sync_queue on every read",
  update_center: "installed version record",
  ai_settings: "FROST settings and thresholds",
  owner_admin_support_contacts: "support contacts shown to staff",
  sale_rate_settings: "sale-rate settings",
  sale_discount_rules: "bill discount rules",
  mandi_tax_rules: "mandi tax rules",
  rebate_rules: "supplier rebate rules",
  charge_types: "other-charge types",
  charge_rate_slabs: "other-charge rate slabs",

  // PEP Menu (combos) and PEP Pack masters
  combos: "combo definitions",
  combo_items: "combo contents",
  combo_packing: "combo packing",
  packing_types: "PEP Pack type master",
  packing_designs: "PEP Pack design master",
  packing_sizes: "PEP Pack size master; unit_cost is kept (see CACHED_COLUMNS)",

  // Replay guards: what stops a stale counter pushing a test bill back
  sync_processed_operations: "replay guard by operation id: a resent operation is answered 'already processed' instead of being applied again",
  sync_pos_sale_staging: "second replay guard for POS bills, by invoice global id / offline ref (both unique per bill, never reused); read only by that duplicate check, by no report",
});

/** Test transactions and everything derived from them. Emptied, sequences continue. */
export const CLEAR = Object.freeze({
  // Sales
  sales: "bills",
  sale_items: "bill lines",
  sale_payments: "bill payments",
  sale_batch_allocations: "which lot each bill line drew from",
  sale_charges: "other charges on bills",
  sale_packing_usage: "packing used by bills",
  sale_audit_trail: "bill edit/cancel history",
  sale_change_approvals: "approvals to edit or cancel a bill",
  pos_rate_override_audit: "manual rate overrides on bills",
  sale_returns: "returns",
  sale_return_items: "return lines",

  // Purchases and stock
  purchases: "purchase entries",
  purchase_items: "purchase lines",
  purchase_audit_trail: "purchase edit/cancel history",
  inventory_batches: "inventory lots (all stock lives here; products have no stock column)",
  stock_transactions: "stock movements",
  stock_adjustments: "stock adjustments",
  stock_reservations: "v3 lot reservations",
  lot_discounts: "discounts on a specific lot (inventory_batch_id is NOT NULL, so none survive their lot)",
  lot_discount_audit: "history of lot discounts",
  waste_entries: "waste",

  // Orders
  customer_orders: "customer orders",
  customer_order_items: "customer order lines",

  // Money
  customer_ledger: "customer ledger entries (opening balance is customers.opening_balance, not a row here)",
  customer_payments: "customer receipts",
  customer_payment_audit: "receipt edit history",
  supplier_payments: "supplier payments",
  supplier_payment_audit: "supplier payment edit history",
  contra_entries: "cash/bank contra entries",
  payment_allocations: "v3 payment allocations",
  expenses: "expenses",
  expense_audit_trail: "expense edit history",

  // PEP Pack transactions
  packing_purchases: "packing purchases",
  packing_purchase_lines: "packing purchase lines",
  packing_movements: "packing stock movements",
  packing_stock: "packing on-hand count per branch and size; every column is derived from packing_movements, and a missing row reads as 0",

  // v3 purchase / transfer protocol
  purchase_orders: "v3 purchase orders",
  purchase_order_items: "v3 purchase order lines",
  goods_receipts: "v3 goods receipts",
  goods_receipt_items: "v3 goods receipt lines",
  supplier_bills: "v3 supplier bills",
  supplier_bill_grn_allocations: "v3 bill-to-GRN allocations",
  dispatch_batches: "v3 dispatch batches",
  inventory_transfers: "stock transfers",
  inventory_transfer_items: "stock transfer lines",
  inventory_transfer_events: "stock transfer history",

  // Sync rows about transactions
  sync_inbox_operations: "pending v3 operations from devices; a pending test operation would also block reassigning its device",
  sync_conflict_log: "sync conflicts raised by test operations",
  sync_queue: "legacy outbound queue (nothing on the cloud writes it)",
  sync_test_entities: "sync self-test rows",

  // Derived from transactions
  ai_alerts: "FROST alerts (overdue customer, pending purchase bill, low stock) computed from test transactions; recomputed from real ones",
  ai_cache: "cached FROST answers computed from test data",
  frost_prediction_runs: "FROST forecasts from test sales",
  frost_predictions: "FROST forecasts from test sales",
  frost_prediction_accuracy: "FROST forecast scoring against test sales",
  whatsapp_send_logs: "record of invoices/statements sent on WhatsApp for test transactions",
});

/** Kept by default. Printed separately; cleared only when named in `--also-clear`. */
export const OWNER_DECIDES = Object.freeze({
  auth_audit_log: "sign-in audit log",
  account_recovery_requests: "password recovery requests (expired OTPs)",
  device_audit_trail: "device approval/edit audit log",
  device_exit_attempt_logs: "kiosk exit attempts",
  device_assignment_history: "history of device assignments",
  backup_logs: "backup run log",
  frost_memories: "facts FROST was taught",
  ai_reminders: "FROST reminders",
  ai_conversations: "FROST chat sessions",
  ai_messages: "FROST chat messages",
  ai_fact_snapshots: "facts attached to FROST chats",
  ai_action_proposals: "actions FROST proposed in chats",
  ai_token_usage: "FROST usage per chat",
  ai_audit_log: "FROST question/answer audit log",
  ai_engine_events: "FROST engine event log",
  product_audit_trail: "mixed: product master edits AND inventory-lot events (OPENING_STOCK, INVENTORY_LOT_*) that the Stock Inventory audit list reads",
  sale_rate_history: "mixed: selling-rate changes from Product Master and from Purchase Entry",
});

/** Rows filtered by entity type rather than kept or cleared whole. */
export const PRUNE = Object.freeze({
  sync_change_log: "rows of a transaction entity type are deleted; master rows stay so the change history devices pull is unbroken; change_id continues",
});

/**
 * Tables deliberately left out of every bucket. If one of them exists, `--apply` refuses until
 * somebody decides what it is.
 */
export const UNCLASSIFIED_BY_DESIGN = Object.freeze({
  cloud_sync_entity_metadata:
    "created only by migration 007, which says 'Do not apply automatically' and is not run; it would hold sync metadata for master and transaction entities alike, so a blanket keep or clear would both be wrong",
});

/**
 * `sync_change_log.entity_type` values, by bucket. Found from every `logSyncChange` /
 * `logMasterDataSyncChange` call in backend/*.js, the SQL inserts in operationalV3.js, and the two
 * triggers of migration 011. An entity type in the live log that is in neither list stops `--apply`.
 */
export const SYNC_TRANSACTION_ENTITY_TYPES = Object.freeze([
  "pos_sale",        // server.js POS sync and bill edit/cancel
  "purchase",        // server.js purchase entry
  "sale_return",     // server.js returns
  "waste_entry",     // server.js waste
  "customer_order",  // server.js customer orders
  "inventory_lot",   // migration 011 trigger on inventory_batches
  "packing_stock",   // froozPack.js publishPackingStock; the table is cleared, so its rows go too
  "sync_test",       // server.js sync self-test
]);

export const SYNC_MASTER_ENTITY_TYPES = Object.freeze([
  "product",
  "product_category",
  "sale_rate",
  "charge_type",
  "charge_rate_slab",
  "combo",
  "packing_type",
  "customer",
  "supplier",
  "location_product", // migration 011 trigger on operational_location_products
]);

/**
 * `product_audit_trail` actions that describe an inventory lot rather than a product. Named with
 * `--also-clear product_audit_trail:lot-events`, only these rows are deleted, so the Stock
 * Inventory audit list stops showing events for lots that no longer exist while product edit
 * history stays. Same list as the Stock Inventory routes in server.js.
 */
export const PRODUCT_AUDIT_LOT_EVENT = "product_audit_trail:lot-events";
export const PRODUCT_AUDIT_LOT_ACTIONS_SQL =
  "action LIKE 'INVENTORY_LOT\\_%' OR action IN ('OPENING_STOCK', 'OPENING_STOCK_LOT_ADDED')";

/**
 * Every column on a kept table that stores a figure that transactions move, and what the fresh
 * start does with it. `reset` is SQL run in the apply transaction; `null` means deliberately kept.
 *
 * The finding, from grepping every UPDATE against a kept table in backend/*.js: the masters carry
 * almost nothing cached. Product stock, customer/supplier balances and combo availability are all
 * computed on read from the transaction tables, so emptying those tables is what resets them.
 * The one stored on-hand figure, packing_stock.qty_on_hand, lives in a table of its own and that
 * table is in CLEAR.
 */
export const CACHED_COLUMNS = Object.freeze([
  {
    column: "packing_stock.qty_on_hand",
    decision: "reset to nothing: the table is in CLEAR (a missing row reads as 0 on the server and on devices)",
    reset: null,
  },
  {
    column: "customers.opening_balance / suppliers.opening_balance / accounts.opening_balance",
    decision: "kept: balances are opening_balance + ledger, computed on read, so with the ledger empty every balance is back to its opening balance",
    reset: null,
  },
  {
    column: "products.selling_rate (+ selling_rate_updated_at/_by)",
    decision: "kept: it is the current price list. Purchase Entry may have set it last, but it is the rate the counter bills at tomorrow, and zeroing it would bill at 0",
    reset: null,
  },
  {
    column: "packing_sizes.unit_cost",
    decision: "kept: a price, not a count -- the last packing purchase rate, also editable in the size master, and carried on every combo's packing; zeroing it would show packing as free until the first packing purchase",
    reset: null,
  },
  {
    column: "authorized_devices.last_sync_at / sync_status, sync_device_configuration.*_count",
    decision: "kept: device telemetry; it is true about the past and the next sync overwrites it",
    reset: null,
  },
  {
    column: "sync_settings.pending_count",
    decision: "kept: /settings/sync-status recomputes it from sync_queue (cleared) on every read",
    reset: null,
  },
]);

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const quote = (name) => {
  if (!IDENTIFIER.test(name)) throw new Error(`refusing an unexpected table name: ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/** Which bucket a table is in, or null. */
export const bucketOf = (table) => {
  if (Object.hasOwn(KEEP, table)) return "KEEP";
  if (Object.hasOwn(CLEAR, table)) return "CLEAR";
  if (Object.hasOwn(OWNER_DECIDES, table)) return "OWNER_DECIDES";
  if (Object.hasOwn(PRUNE, table)) return "PRUNE";
  return null;
};

/** The single TRUNCATE the apply runs. No cascade, sequences continue. */
export const buildTruncateSql = (tables) => {
  const list = [...new Set(tables)];
  if (list.length === 0) throw new Error("nothing to truncate");
  for (const table of list) {
    const bucket = bucketOf(table);
    if (bucket !== "CLEAR" && bucket !== "OWNER_DECIDES") {
      throw new Error(`${table} is ${bucket || "unclassified"}; only CLEAR or owner-approved tables may be truncated`);
    }
  }
  return `TRUNCATE TABLE ${list.map(quote).join(", ")} CONTINUE IDENTITY`;
};

/** The sync_change_log prune. Parameter $1 is SYNC_TRANSACTION_ENTITY_TYPES. */
export const buildPruneSql = () => ({
  text: "DELETE FROM sync_change_log WHERE entity_type = ANY($1::TEXT[])",
  values: [[...SYNC_TRANSACTION_ENTITY_TYPES]],
});

/** Deletes only the inventory-lot rows of product_audit_trail. */
export const buildProductAuditLotEventSql = () =>
  `DELETE FROM product_audit_trail WHERE ${PRODUCT_AUDIT_LOT_ACTIONS_SQL}`;

/**
 * The judgement over a live catalogue, pure so it can be tested without a database.
 *
 * `liveTables` are the base tables of `public`; `entityTypes` the distinct
 * `sync_change_log.entity_type` values; `alsoClear` the owner's `--also-clear` list.
 * Returns the plan and every reason `--apply` must refuse.
 */
export const planReset = ({ liveTables, entityTypes = [], alsoClear = [] }) => {
  const live = [...new Set(liveTables)].sort();
  const refusals = [];

  const unclassified = live.filter((table) => !bucketOf(table));
  for (const table of unclassified) {
    const why = UNCLASSIFIED_BY_DESIGN[table];
    refusals.push(
      why
        ? `table ${table} exists and is deliberately unclassified: ${why}`
        : `table ${table} is not classified in scripts/cloud/goLiveResetPlan.mjs`,
    );
  }

  const known = new Set([...SYNC_TRANSACTION_ENTITY_TYPES, ...SYNC_MASTER_ENTITY_TYPES]);
  const unknownTypes = [...new Set(entityTypes)].filter((type) => !known.has(type)).sort();
  for (const type of unknownTypes) {
    refusals.push(`sync_change_log has entity type '${type}', which is neither a master nor a transaction type in goLiveResetPlan.mjs`);
  }

  const ownerTruncate = [];
  let pruneProductAuditLotEvents = false;
  for (const name of alsoClear) {
    if (name === PRODUCT_AUDIT_LOT_EVENT) {
      pruneProductAuditLotEvents = true;
    } else if (Object.hasOwn(OWNER_DECIDES, name)) {
      if (live.includes(name)) ownerTruncate.push(name);
    } else {
      refusals.push(`--also-clear accepts only owner-decides tables or ${PRODUCT_AUDIT_LOT_EVENT}; '${name}' is ${bucketOf(name) || "not a known table"}`);
    }
  }
  if (pruneProductAuditLotEvents && ownerTruncate.includes("product_audit_trail")) pruneProductAuditLotEvents = false;

  const byBucket = (bucket) => live.filter((table) => bucketOf(table) === bucket);
  const missingClear = Object.keys(CLEAR).filter((table) => !live.includes(table)).sort();

  return {
    keep: byBucket("KEEP"),
    clear: byBucket("CLEAR"),
    ownerDecides: byBucket("OWNER_DECIDES"),
    prune: byBucket("PRUNE"),
    unclassified,
    unknownEntityTypes: unknownTypes,
    missingClear,
    ownerTruncate: [...new Set(ownerTruncate)].sort(),
    pruneProductAuditLotEvents,
    truncate: [...byBucket("CLEAR"), ...new Set(ownerTruncate)],
    refusals,
  };
};

/**
 * Foreign keys from a table that survives into a table being truncated. TRUNCATE without a cascade
 * refuses these anyway; finding them first turns a PostgreSQL error into a sentence.
 * `foreignKeys` is `[{ from, to }]`.
 */
export const blockingForeignKeys = ({ foreignKeys, truncate }) => {
  const doomed = new Set(truncate);
  return foreignKeys
    .filter(({ from, to }) => doomed.has(to) && !doomed.has(from))
    .map(({ from, to }) => `${from} -> ${to}`)
    .sort();
};
