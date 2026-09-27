import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { labelFor, toneFor } from "./displayLabels.js";

const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("App.jsx reads enum codes through labelFor, and badge classes through toneFor", () => {
  assert.match(app, /import \{ labelFor, toneFor \} from "\.\/local\/displayLabels";/);
  assert.match(app, /const STATUS_TONE_CLASS = Object\.freeze\(\{ success: "stock-ok", warning: "origin-rate", danger: "stock-low", info: "tag", neutral: "tag" \}\);/);
});

test("the tables that printed raw codes now print labels", () => {
  for (const expression of [
    'labelFor("refundType", entry.refund_type)',
    'labelFor("wasteType", entry.waste_type)',
    'labelFor("paymentMode", expense.payment_mode)',
    'labelFor("recordStatus", status)',
    'labelFor("accountType", account.account_type)',
    'labelFor("discountType", discount.discount_type)',
    'labelFor("orderStatus", order.status)',
    'labelFor("orderSource", order.source)',
    'labelFor("auditAction", row.action)',
    'labelFor("transactionType", row.transaction_type)',
  ]) {
    assert.ok(app.includes(expression), `missing ${expression}`);
  }
  // The raw cells are gone.
  assert.doesNotMatch(app, /<span className="tag">\{entry\.refund_type\}<\/span>/);
  assert.doesNotMatch(app, /<span className="tag">\{account\.account_type\}<\/span>/);
  assert.doesNotMatch(app, /<td>\{discount\.discount_type\}<\/td>/);
});

test("comparisons still use the raw code, only the words changed", () => {
  // Filters and option values keep the stored value.
  assert.match(app, /<option key=\{mode\} value=\{mode\}>\{labelFor\("paymentMode", mode\)\}<\/option>/);
  assert.match(app, /discount\.discount_type === "PERCENTAGE"/);
});

test("labels read as words and a missing value never reads as zero", () => {
  assert.equal(labelFor("paymentMode", "BANK_TRANSFER"), "Bank transfer");
  assert.equal(labelFor("discountType", "FIXED_AMOUNT"), "Fixed amount");
  assert.equal(labelFor("paymentMode", ""), "—");
  assert.equal(toneFor("recordStatus", "CANCELLED"), "danger");
});
