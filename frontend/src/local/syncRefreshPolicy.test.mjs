import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { shouldRefreshAfterSync, shouldSyncAfterPurchaseSave } from "./syncRefreshPolicy.js";

test("a completed pull refreshes the screens even when the push failed", () => {
  assert.equal(shouldRefreshAfterSync({ lastError: "push refused", pullCompleted: true }), true);
  assert.equal(shouldRefreshAfterSync({ lastError: "", pullCompleted: false }), true);
  assert.equal(shouldRefreshAfterSync({ lastError: "offline", pullCompleted: false }), false);
  assert.equal(shouldRefreshAfterSync(null), false);
});

test("only an online desktop save starts an immediate sync", () => {
  assert.equal(shouldSyncAfterPurchaseSave({ tauriRuntime: true }), true);
  assert.equal(shouldSyncAfterPurchaseSave({ tauriRuntime: false }), false);
  assert.equal(shouldSyncAfterPurchaseSave({ tauriRuntime: true, queuedOffline: true }), false);
});

test("App wires both, after the queued-offline branch has returned", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /if \(shouldRefreshAfterSync\(status\)\) await refreshBusinessDataAfterSync\(\);/);
  const save = app.slice(app.indexOf("const savePurchase = async"), app.indexOf("const loadInvoice = async"));
  const queuedReturn = save.indexOf('alert("Purchase saved locally');
  const sync = save.indexOf("runSyncNow({ force: true })");
  assert.ok(queuedReturn > 0 && sync > queuedReturn, "the sync belongs to the online path only");
  assert.ok(sync < save.indexOf('"Stock Arrival Saved - Bill Pending"'), "started before the success message, not awaited");
  assert.doesNotMatch(save.slice(sync - 20, sync), /await /);
});
