import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { collectWorkInProgress, WORK_IN_PROGRESS_KINDS } from "./deviceWorkInProgress.js";

const idsFor = (facts) => collectWorkInProgress(facts).map((entry) => entry.id);

test("a counter with nothing on it is free", () => {
  assert.deepEqual(collectWorkInProgress({}), []);
  assert.deepEqual(collectWorkInProgress(), []);
  assert.deepEqual(collectWorkInProgress(null), []);
});

test("a bill being made is work in progress", () => {
  // The whole reason this module exists. A restart here loses the half-made bill with the
  // customer standing there.
  assert.deepEqual(idsFor({ posCartLines: 3 }), ["pos-cart"]);
  assert.deepEqual(idsFor({ posCartLines: [{}, {}] }), ["pos-cart"]);
  assert.deepEqual(idsFor({ posCartLines: 0 }), []);
  assert.deepEqual(idsFor({ posCartLines: [] }), []);
});

test("a save in flight is work in progress", () => {
  assert.deepEqual(idsFor({ posSaving: true }), ["pos-saving"]);
  assert.deepEqual(idsFor({ purchaseSaving: true }), ["purchase-saving"]);
});

test("a half-entered purchase counts too", () => {
  assert.deepEqual(idsFor({ purchaseCartLines: 1 }), ["purchase-cart"]);
});

test("an order waiting to become a bill counts", () => {
  // Failing this handoff is called out in App.jsx as unrecoverable by re-billing.
  assert.deepEqual(idsFor({ pendingOrderBill: { id: 4 } }), ["order-handoff"]);
  assert.deepEqual(idsFor({ pendingOrderBill: null }), []);
});

test("any open form is one reason, not six", () => {
  // The person reading "will install once this is finished: ..." does not need an inventory of
  // which form is open.
  for (const fact of ["editingSale", "cancelDraft", "lotAction", "editingProductId", "editingPurchaseId", "addingOpeningStock"]) {
    assert.deepEqual(idsFor({ [fact]: 7 }), ["open-form"], `${fact} must block a restart`);
  }
  assert.deepEqual(idsFor({ editingSale: 1, cancelDraft: 2, lotAction: 3 }), ["open-form"]);
});

test("sales that have not been sent yet block a restart", () => {
  // These are completed sales that exist only on this machine until they are sent. The manual
  // install path already refuses while the outbox is not empty.
  assert.deepEqual(idsFor({ pendingSyncOperations: 2 }), ["pending-sync"]);
  assert.deepEqual(idsFor({ pendingSyncOperations: 0 }), []);
});

test("a backup mid-write blocks a restart", () => {
  assert.deepEqual(idsFor({ backupRunning: true }), ["backup"]);
});

test("a print blocks a restart", () => {
  assert.deepEqual(idsFor({ printingInvoice: "thermal" }), ["printing"]);
});

test("the running operations collapse into one reason", () => {
  for (const fact of ["shopSwitching", "distributionBusy", "orderActionBusy", "orderRoutingBusy", "connectivitySwitching"]) {
    assert.deepEqual(idsFor({ [fact]: true }), ["busy-operation"], `${fact} must block a restart`);
  }
  assert.deepEqual(idsFor({ shopSwitching: true, distributionBusy: true }), ["busy-operation"]);
});

test("a machine still starting up is not idle", () => {
  // The backend sidecar is still settling underneath it, and restarting into that is how a
  // half-applied update happens.
  assert.deepEqual(idsFor({ startupSettled: false }), ["starting-up"]);
  assert.deepEqual(idsFor({ startupSettled: true }), []);
  assert.deepEqual(idsFor({}), [], "unknown startup state is not treated as still starting");
});

test("several kinds of work are all named, in order of how much they hurt", () => {
  const ids = idsFor({
    posCartLines: 2,
    posSaving: true,
    pendingSyncOperations: 5,
    startupSettled: false,
  });
  assert.deepEqual(ids, ["pos-cart", "pos-saving", "pending-sync", "starting-up"]);
});

test("every reason carries a label a person could read", () => {
  const everything = collectWorkInProgress({
    posCartLines: 1,
    posSaving: true,
    purchaseCartLines: 1,
    purchaseSaving: true,
    pendingOrderBill: {},
    editingSale: 1,
    printingInvoice: true,
    pendingSyncOperations: 1,
    backupRunning: true,
    shopSwitching: true,
    startupSettled: false,
  });
  assert.equal(everything.length, Object.keys(WORK_IN_PROGRESS_KINDS).length);
  for (const entry of everything) {
    assert.match(entry.label, /^[a-z]/, "labels read as the tail of a sentence");
    assert.ok(entry.label.length > 3);
    assert.ok(!entry.label.includes("_"), "no internal identifiers leak into the sentence");
  }
});

test("a reason is never listed twice", () => {
  const ids = idsFor({ editingSale: 1, editingProductId: 2, shopSwitching: true, orderActionBusy: true });
  assert.deepEqual(ids, [...new Set(ids)]);
});

test("the shell passes every fact this module reads", () => {
  // The module treats a missing fact as "not busy", so a fact the shell forgets to pass is a
  // restart that ignores a real bill. The safety is here rather than in the default.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const wired = app.slice(app.indexOf("collectWorkInProgress({"), app.indexOf("collectWorkInProgress({") + 1200);
  assert.ok(wired.startsWith("collectWorkInProgress({"), "the shell must build its facts in one literal");
  for (const fact of [
    "posCartLines", "posSaving", "purchaseCartLines", "purchaseSaving", "pendingOrderBill",
    "editingSale", "cancelDraft", "lotAction", "editingProductId", "editingPurchaseId",
    "addingOpeningStock", "printingInvoice", "pendingSyncOperations", "backupRunning",
    "shopSwitching", "distributionBusy", "orderActionBusy", "orderRoutingBusy",
    "connectivitySwitching", "startupSettled",
  ]) {
    // Either spelling counts: `posSaving: posWork.saving` and the shorthand `pendingOrderBill,`.
    assert.match(wired, new RegExp(`\\b${fact}\\s*[:,]`), `the shell must pass ${fact}`);
  }
});
