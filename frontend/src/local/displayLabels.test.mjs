import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ACCOUNT_TYPE_LABELS,
  ACTIVATION_CODE_STATUS_LABELS,
  ADJUSTMENT_TYPE_LABELS,
  AUDIT_ACTION_LABELS,
  BACKUP_STATUS_LABELS,
  BACKUP_TYPE_LABELS,
  BATCH_STATUS_LABELS,
  COUNTER_TYPE_LABELS,
  CUSTOMER_TYPE_LABELS,
  DEVICE_STATUS_LABELS,
  DEVICE_TYPE_LABELS,
  DEVICE_USAGE_LABELS,
  DISCOUNT_TYPE_LABELS,
  LOT_DISCOUNT_STATUS_LABELS,
  DISPLAY_LABEL_FAMILIES,
  DISPLAY_LABEL_FAMILY_ALIASES,
  DISPLAY_LABEL_MAPS,
  DISPLAY_TONES,
  EMPTY_LABEL,
  LABEL_ACRONYMS,
  LOCATION_TYPE_LABELS,
  MESSAGE_STATUS_LABELS,
  ORDER_PAYMENT_STATE_LABELS,
  ORDER_SOURCE_LABELS,
  ORDER_STATUS_LABELS,
  ORIGIN_LABELS,
  PAYMENT_MODE_LABELS,
  PAYMENT_STATUS_LABELS,
  PURCHASE_BILL_STATUS_LABELS,
  RECORD_STATUS_LABELS,
  REFUND_TYPE_LABELS,
  STATUS_TONE_FAMILIES,
  STOCK_SOURCE_LABELS,
  SUPPLIER_TYPE_LABELS,
  SYNC_STATUS_LABELS,
  TRANSACTION_TYPE_LABELS,
  UNIT_LABELS,
  WASTE_TYPE_LABELS,
  humanizeCode,
  labelFor,
  normalizeCode,
  resolveFamily,
  toneFor,
} from "./displayLabels.js";
import * as displayLabels from "./displayLabels.js";
import { ORDER_STATUS, PAYMENT_STATE } from "./orderLifecycle.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const readRepoFile = (relative) => fs.readFileSync(path.join(repoRoot, relative), "utf8");

// Words allowed to start with a capital letter after the first word of a label.
const PROPER_NOUNS = new Set(["WhatsApp", "Android", "Windows", "iPhone"]);
const ACRONYMS = new Set(LABEL_ACRONYMS);

const EXPECTED_FAMILIES = {
  paymentMode: PAYMENT_MODE_LABELS,
  accountType: ACCOUNT_TYPE_LABELS,
  supplierType: SUPPLIER_TYPE_LABELS,
  customerType: CUSTOMER_TYPE_LABELS,
  transactionType: TRANSACTION_TYPE_LABELS,
  discountType: DISCOUNT_TYPE_LABELS,
  lotDiscountStatus: LOT_DISCOUNT_STATUS_LABELS,
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

/** Values from `const NAME = new Set([...])` / `const NAME = [...]` in backend/server.js. */
const backendSet = (name) => {
  const source = readRepoFile("backend/server.js");
  const match = source.match(new RegExp(`const ${name} = (?:new Set\\()?\\[([^\\]]*)\\]`));
  assert.ok(match, `backend/server.js no longer declares ${name}; update this test and displayLabels.js together`);
  return [...match[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
};

/** Values from a SQLite `CHECK (column IN (...))`. */
const sqliteCheck = (file, column) => {
  const source = readRepoFile(`src-tauri/migrations/sqlite/${file}`);
  const match = source.match(new RegExp(`${column} IN \\(([^)]*)\\)`));
  assert.ok(match, `${file} no longer has a CHECK on ${column}`);
  return [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
};

const assertEveryValueLabelled = (family, values) => {
  const map = DISPLAY_LABEL_MAPS[family];
  for (const value of values) {
    assert.ok(Object.prototype.hasOwnProperty.call(map, normalizeCode(value)), `${family} has no explicit label for ${value}`);
  }
};

test("exports one frozen map per family and lists every family", () => {
  assert.deepEqual([...DISPLAY_LABEL_FAMILIES].sort(), Object.keys(EXPECTED_FAMILIES).sort());
  for (const [family, map] of Object.entries(EXPECTED_FAMILIES)) {
    assert.equal(DISPLAY_LABEL_MAPS[family], map, `${family} map is not the exported one`);
    assert.ok(Object.keys(map).length > 0, `${family} is empty`);
  }
});

test("every exported map, list and tone map is frozen", () => {
  const exported = Object.entries(displayLabels).filter(([, value]) => value && typeof value === "object");
  assert.ok(exported.length >= DISPLAY_LABEL_FAMILIES.length + 5);
  for (const [name, value] of exported) {
    assert.ok(Object.isFrozen(value), `${name} is not frozen`);
  }
  assert.throws(() => {
    "use strict";
    PAYMENT_MODE_LABELS.CASH = "Money";
  }, TypeError);
  assert.equal(PAYMENT_MODE_LABELS.CASH, "Cash");
});

test("every map key is already in normalised form", () => {
  for (const [family, map] of Object.entries(DISPLAY_LABEL_MAPS)) {
    for (const key of Object.keys(map)) {
      assert.equal(normalizeCode(key), key, `${family}.${key} would never be found`);
    }
  }
});

test("labels are short, readable sentence case with no underscores or shouting", () => {
  for (const [family, map] of Object.entries(DISPLAY_LABEL_MAPS)) {
    for (const [key, label] of Object.entries(map)) {
      const where = `${family}.${key} = ${JSON.stringify(label)}`;
      assert.equal(typeof label, "string", where);
      assert.ok(label.trim().length > 0, `${where} is empty`);
      assert.equal(label, label.trim(), `${where} has padding`);
      assert.ok(label.length <= 32, `${where} is too long for a table cell`);
      assert.ok(!label.includes("_"), `${where} contains an underscore`);
      assert.notEqual(label, "0", where);
      assert.notEqual(label, EMPTY_LABEL, where);

      const words = label.split(/[\s/()]+/).filter(Boolean);
      for (const [index, word] of words.entries()) {
        const letters = word.replace(/[^A-Za-z]/g, "");
        if (letters.length > 1 && letters === letters.toUpperCase()) {
          assert.ok(ACRONYMS.has(letters), `${where}: "${word}" is all caps and not an accepted acronym`);
        }
        if (index > 0 && /^[A-Z]/.test(word) && !ACRONYMS.has(letters)) {
          assert.ok(PROPER_NOUNS.has(word), `${where}: "${word}" breaks sentence case`);
        }
      }
      if (!PROPER_NOUNS.has(words[0])) {
        assert.match(label, /^[A-Z]/, `${where} does not start with a capital`);
      }
    }
  }
});

test("units read Kg, Box, Piece, Dozen", () => {
  assert.deepEqual(
    ["KG", "BOX", "PIECE", "DOZEN"].map((unit) => labelFor("unit", unit)),
    ["Kg", "Box", "Piece", "Dozen"],
  );
  assert.equal(labelFor("unit", "kg"), "Kg");
});

test("each family turns its codes into plain words", () => {
  const cases = [
    ["paymentMode", "BANK_TRANSFER", "Bank transfer"],
    ["paymentMode", "UPI", "UPI"],
    ["paymentMode", "MIXED", "Mixed payment"],
    ["paymentMode", "CREDIT", "Credit (pay later)"],
    ["accountType", "CUSTOMER", "Customer"],
    ["accountType", "TRANSPORT_VENDOR", "Transport vendor"],
    ["accountType", "CONTRA", "Cash/bank transfer"],
    ["supplierType", "IMPORTED_SUPPLIER", "Imported goods supplier"],
    ["customerType", "WHOLESALE", "Wholesale"],
    ["transactionType", "IN", "Stock in"],
    ["transactionType", "OUT", "Stock out"],
    ["transactionType", "SALE_EDIT_CREDIT", "Sale edited (due reduced)"],
    ["transactionType", "Customer Payment", "Customer payment"],
    ["transactionType", "POS Sale", "Counter sale"],
    ["transactionType", "Supplier Purchase Cancellation", "Supplier purchase cancelled"],
    ["discountType", "FIXED_AMOUNT", "Rupees off per unit"],
    ["discountType", "FLAT_AMOUNT", "Rupees off bill"],
    ["discountType", "PERCENTAGE", "Percent off"],
    ["discountType", "SPECIAL_RATE", "Fixed price"],
    ["lotDiscountStatus", "RUNNING", "Running"],
    ["lotDiscountStatus", "UPCOMING", "Starts later"],
    ["refundType", "FUTURE_ADJUSTMENT", "Adjust in next sale"],
    ["refundType", "UPI_REFUND", "UPI refund"],
    ["unit", "PIECE", "Piece"],
    ["origin", "LOCAL", "Local"],
    ["origin", "IMPORTED", "Imported"],
    ["wasteType", "DAAGI", "Daagi (damaged)"],
    ["wasteType", "PERSONAL_USE", "Personal use"],
    ["stockSource", "OPENING_STOCK", "Opening stock"],
    ["adjustmentType", "Physical Count Correction", "Stock count correction"],
    ["adjustmentType", "Owner Adjustment", "Owner adjustment"],
    ["auditAction", "INVENTORY_LOT_ADJUST", "Stock adjusted"],
    ["auditAction", "EDIT", "Edited"],
    ["auditAction", "PRODUCT_PHOTO_SET", "Photo added"],
    ["recordStatus", "ACTIVE", "Active"],
    ["recordStatus", "CANCELLED", "Cancelled"],
    ["batchStatus", "EXHAUSTED", "Sold out"],
    ["purchaseBillStatus", "BILL_PENDING", "Bill pending"],
    ["paymentStatus", "Partially Paid", "Partly paid"],
    ["orderStatus", "RECEIVED", "Received"],
    ["orderSource", "WHATSAPP", "WhatsApp"],
    ["orderPaymentState", "ON_DELIVERY", "Pay on delivery"],
    ["deviceStatus", "PENDING", "Waiting for approval"],
    ["activationCodeStatus", "USED", "Used"],
    ["backupStatus", "SUCCESS", "Done"],
    ["syncStatus", "conflict", "Needs review"],
    ["messageStatus", "sent", "Sent"],
    ["locationType", "MANDI_COUNTER", "Mandi counter"],
    ["counterType", "RETAIL_COUNTER", "Retail counter"],
    ["deviceType", "ANDROID_PHONE", "Android phone"],
    ["deviceType", "IPHONE", "iPhone"],
    ["deviceType", "tauri-windows", "Windows app"],
    ["deviceUsage", "POS", "Billing (POS)"],
    ["deviceUsage", "PURCHASE_ENTRY", "Purchase entry"],
    ["backupType", "Shutdown", "On shutdown"],
  ];
  for (const [family, value, expected] of cases) {
    assert.equal(labelFor(family, value), expected, `${family} ${value}`);
  }
  // Every family's every entry resolves through labelFor exactly.
  for (const [family, map] of Object.entries(DISPLAY_LABEL_MAPS)) {
    for (const [key, label] of Object.entries(map)) {
      assert.equal(labelFor(family, key), label, `${family}.${key}`);
    }
  }
});

test("lookup ignores case, padding and treats -, _ and spaces the same", () => {
  const spellings = ["BANK_TRANSFER", "bank_transfer", "Bank Transfer", "bank-transfer", "  BANK  TRANSFER ", "Bank__Transfer", "bank - transfer", "\tbank_transfer\n"];
  for (const spelling of spellings) {
    assert.equal(labelFor("paymentMode", spelling), "Bank transfer", JSON.stringify(spelling));
  }
  assert.equal(labelFor("orderPaymentState", "on delivery"), "Pay on delivery");
  assert.equal(labelFor("auditAction", "inventory-lot-transfer-out"), "Moved out");
  assert.equal(normalizeCode("  a - b_c  d "), "A_B_C_D");
  assert.equal(normalizeCode("_x_"), "X");
});

test("family names are case and separator insensitive and accept column names", () => {
  for (const spelling of ["paymentMode", "payment_mode", "PAYMENT_MODE", "payment-mode", "Payment Mode"]) {
    assert.equal(resolveFamily(spelling), "paymentMode", spelling);
    assert.equal(labelFor(spelling, "CHEQUE"), "Cheque", spelling);
  }
  assert.equal(labelFor("origin_type", "IMPORTED"), "Imported");
  assert.equal(labelFor("batch_status", "CANCELLED"), "Cancelled");
  assert.equal(labelFor("refund_type", "CREDIT_NOTE"), "Credit note");
  assert.equal(labelFor("waste_type", "SAMPLING"), "Sampling");
  assert.equal(labelFor("intended_usage", "OWNER_DASHBOARD"), "Owner dashboard");
  assert.equal(labelFor("payment_source", "SUPPLIER"), "Supplier");
  assert.equal(labelFor("credit_status", "Paid"), "Paid");
  assert.equal(labelFor("voucher_type", "Purchase Cancellation"), "Purchase cancelled");
  for (const [alias, family] of Object.entries(DISPLAY_LABEL_FAMILY_ALIASES)) {
    assert.ok(DISPLAY_LABEL_FAMILIES.includes(family), `${alias} points at unknown family ${family}`);
    assert.equal(resolveFamily(alias), family);
  }
  assert.equal(resolveFamily("status"), "", "a bare 'status' is ambiguous and must not pick a family");
  assert.equal(resolveFamily("not a family"), "");
});

test("an active flag reads Active / Inactive", () => {
  assert.equal(labelFor("recordStatus", true), "Active");
  assert.equal(labelFor("recordStatus", false), "Inactive");
  assert.equal(labelFor("active", "true"), "Active");
  assert.equal(toneFor("recordStatus", false), "danger");
});

test("an unknown code is never hidden: it is built into words from the code", () => {
  assert.equal(labelFor("paymentMode", "SOME_NEW_CODE"), "Some new code");
  assert.equal(labelFor("orderStatus", "out-for-delivery"), "Out for delivery");
  assert.equal(labelFor("wasteType", "rotten fruit"), "Rotten fruit");
  assert.equal(labelFor("paymentMode", "UPI_LITE"), "UPI lite");
  assert.equal(labelFor("paymentMode", "gst_input"), "GST input");
  assert.equal(labelFor("no-such-family", "SOME_NEW_CODE"), "Some new code");
  assert.equal(labelFor(undefined, "X"), "X");
  // Already-human text keeps its own casing, so names inside it survive.
  assert.equal(labelFor("deviceType", "Desktop Browser - Chrome"), "Desktop Browser - Chrome");
  assert.equal(labelFor("transactionType", "Cash Book Date Summary"), "Day summary");
  // Non-string values are shown, not dropped.
  assert.equal(labelFor("unit", 0), "0");
  assert.equal(labelFor("unit", 12), "12");
  for (const value of ["SOME_NEW_CODE", "a_b", "Z", "x-y z"]) {
    const label = labelFor("paymentMode", value);
    assert.ok(label && label !== EMPTY_LABEL, `${value} was hidden`);
    assert.ok(!label.includes("_"), `${value} kept an underscore`);
  }
  assert.equal(humanizeCode("NEW__THING--HERE"), "New thing here");
  assert.equal(humanizeCode("pos"), "POS");
});

test("a missing value reads as an em dash, never empty and never zero", () => {
  assert.equal(EMPTY_LABEL, "—");
  for (const value of [null, undefined, "", "   ", "\n\t"]) {
    for (const family of DISPLAY_LABEL_FAMILIES) {
      assert.equal(labelFor(family, value), "—", `${family} ${JSON.stringify(value)}`);
    }
    assert.equal(labelFor("unknown", value), "—");
    assert.equal(humanizeCode(value), "—");
    assert.equal(toneFor("orderStatus", value), "neutral");
  }
});

test("toneFor maps status families and is neutral elsewhere", () => {
  const cases = [
    ["recordStatus", "ACTIVE", "success"],
    ["recordStatus", "COMPLETED", "success"],
    ["recordStatus", "EDITED", "info"],
    ["recordStatus", "INACTIVE", "danger"],
    ["recordStatus", "cancelled", "danger"],
    ["batchStatus", "ACTIVE", "success"],
    ["batchStatus", "EXHAUSTED", "warning"],
    ["batchStatus", "EXPIRED", "danger"],
    ["purchaseBillStatus", "BILL_COMPLETED", "success"],
    ["purchaseBillStatus", "BILL_PENDING", "warning"],
    ["paymentStatus", "Paid", "success"],
    ["paymentStatus", "Partially Paid", "warning"],
    ["paymentStatus", "Pending", "warning"],
    ["orderStatus", "DELIVERED", "success"],
    ["orderStatus", "RECEIVED", "warning"],
    ["orderStatus", "PACKED", "info"],
    ["orderStatus", "CANCELLED", "danger"],
    ["orderPaymentState", "PAID", "success"],
    ["orderPaymentState", "UNPAID", "warning"],
    ["deviceStatus", "APPROVED", "success"],
    ["deviceStatus", "PENDING", "warning"],
    ["deviceStatus", "REJECTED", "danger"],
    ["deviceStatus", "DISABLED", "danger"],
    ["activationCodeStatus", "ACTIVE", "success"],
    ["activationCodeStatus", "REVOKED", "danger"],
    ["backupStatus", "SUCCESS", "success"],
    ["lotDiscountStatus", "RUNNING", "success"],
    ["lotDiscountStatus", "UPCOMING", "warning"],
    ["lotDiscountStatus", "STOPPED", "neutral"],
    ["backupStatus", "RUNNING", "info"],
    ["backupStatus", "FAILED", "danger"],
    ["syncStatus", "completed", "success"],
    ["syncStatus", "pending", "warning"],
    ["syncStatus", "failed", "danger"],
    ["syncStatus", "conflict", "danger"],
    ["messageStatus", "sent", "success"],
    ["messageStatus", "failed", "danger"],
    // Not status families: always neutral.
    ["paymentMode", "CASH", "neutral"],
    ["unit", "KG", "neutral"],
    ["origin", "IMPORTED", "neutral"],
    // Unknown codes and families claim nothing.
    ["orderStatus", "SOMETHING_NEW", "neutral"],
    ["nope", "ACTIVE", "neutral"],
  ];
  for (const [family, value, tone] of cases) {
    assert.equal(toneFor(family, value), tone, `${family} ${value}`);
  }
  for (const family of DISPLAY_LABEL_FAMILIES) {
    for (const key of Object.keys(DISPLAY_LABEL_MAPS[family])) {
      assert.ok(DISPLAY_TONES.includes(toneFor(family, key)), `${family}.${key}`);
    }
  }
});

test("every status family has a tone for every one of its codes, and no stray ones", () => {
  for (const family of STATUS_TONE_FAMILIES) {
    const labels = DISPLAY_LABEL_MAPS[family];
    const toneMapName = Object.keys(displayLabels).find((name) => name.endsWith("_TONES")
      && name.replace(/_TONES$/, "_LABELS") in displayLabels
      && displayLabels[name.replace(/_TONES$/, "_LABELS")] === labels);
    assert.ok(toneMapName, `${family} has no *_TONES export`);
    const tones = displayLabels[toneMapName];
    assert.deepEqual(Object.keys(tones).sort(), Object.keys(labels).sort(), `${toneMapName} keys differ from its labels`);
    for (const tone of Object.values(tones)) assert.ok(DISPLAY_TONES.includes(tone), `${toneMapName}: ${tone}`);
  }
});

test("every value the backend declares has an explicit label", () => {
  assertEveryValueLabelled("paymentMode", backendSet("SUPPLIER_PAYMENT_MODES"));
  assertEveryValueLabelled("paymentMode", backendSet("BANK_PAYMENT_MODES"));
  assertEveryValueLabelled("paymentMode", backendSet("DISCOUNT_PAYMENT_MODES"));
  assertEveryValueLabelled("supplierType", backendSet("SUPPLIER_TYPES"));
  assertEveryValueLabelled("customerType", backendSet("CUSTOMER_TYPES"));
  assertEveryValueLabelled("accountType", backendSet("ACCOUNT_TYPES"));
  assertEveryValueLabelled("discountType", backendSet("DISCOUNT_TYPES"));
  assertEveryValueLabelled("discountType", backendSet("LOT_DISCOUNT_TYPES"));
  assertEveryValueLabelled("recordStatus", backendSet("SALE_STATUSES"));
  assertEveryValueLabelled("refundType", backendSet("REFUND_TYPES"));
  assertEveryValueLabelled("wasteType", backendSet("WASTE_TYPES"));
  assertEveryValueLabelled("purchaseBillStatus", backendSet("PURCHASE_BILL_STATUSES"));
  assertEveryValueLabelled("unit", backendSet("PRODUCT_UNITS"));
});

test("every order value the local schema allows has an explicit label", () => {
  assertEveryValueLabelled("orderStatus", sqliteCheck("020_customer_orders.sql", "status"));
  assertEveryValueLabelled("orderSource", sqliteCheck("020_customer_orders.sql", "source"));
  assertEveryValueLabelled("orderPaymentState", sqliteCheck("021_customer_order_payment.sql", "payment_state"));
  assertEveryValueLabelled("syncStatus", sqliteCheck("022_customer_order_sync.sql", "sync_status"));
  assertEveryValueLabelled("syncStatus", sqliteCheck("014_offline_purchase_grn.sql", "state"));
  assertEveryValueLabelled("orderStatus", Object.values(ORDER_STATUS));
  assertEveryValueLabelled("orderPaymentState", Object.values(PAYMENT_STATE));
  assert.deepEqual(Object.keys(ORDER_STATUS_LABELS).sort(), Object.values(ORDER_STATUS).sort());
});

test("the module stays pure: no DOM, network or storage access", () => {
  const source = readRepoFile("frontend/src/local/displayLabels.js");
  for (const forbidden of ["window.", "document.", "localStorage", "fetch(", "axios", "import "]) {
    assert.ok(!source.includes(forbidden), `displayLabels.js uses ${forbidden}`);
  }
});
