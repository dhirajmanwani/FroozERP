import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { resolveConnectionStatus } from "./connectionStatus.js";
import { resolveShellStatus, SHELL_STATUS_FORBIDDEN_WORDS } from "./shellStatus.js";

const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

const synced = resolveConnectionStatus({ cloudReachable: true, localServiceReady: true });
const offline = resolveConnectionStatus({ cloudReachable: false, localServiceReady: true, pendingCount: 3 });
const held = resolveConnectionStatus({ cloudReachable: false, heldOffline: true, localServiceReady: true });
const catchingUp = resolveConnectionStatus({ cloudReachable: true, pendingCount: 2, localServiceReady: true });

const noForbiddenWords = (text) => {
  for (const word of SHELL_STATUS_FORBIDDEN_WORDS) {
    assert.ok(!text.toLowerCase().includes(word.toLowerCase()), `"${text}" must not say "${word}"`);
  }
};

test("all well: the pill says so and no panel is shown", () => {
  const { pill, notice } = resolveShellStatus({ connection: synced });
  assert.equal(pill.label, "Saved to cloud");
  assert.equal(notice, null);
});

test("offline and kept-offline always change the pill, never silently", () => {
  const off = resolveShellStatus({ connection: offline, pendingCount: 3 });
  assert.equal(off.pill.label, "Offline · 3 to send");
  assert.equal(off.pill.tone, "notice");
  const kept = resolveShellStatus({ connection: held });
  assert.equal(kept.pill.label, "Kept offline");
  assert.equal(kept.pill.tone, "problem");
  // The banner (resolveConnectionStatus) carries the sentence for both; the panel does not repeat it.
  assert.equal(off.notice, null);
  assert.equal(kept.notice, null);
  assert.equal(offline.showsInTopBar, true);
  assert.equal(held.showsInTopBar, true);
});

test("a failed sync shows in the pill and gets one plain sentence", () => {
  const { pill, notice } = resolveShellStatus({ connection: synced, failedCount: 2 });
  assert.equal(pill.label, "Sync failed");
  assert.equal(notice.tone, "warning");
  assert.match(notice.message, /2 changes could not be sent/);
  noForbiddenWords(notice.message);
});

test("conflicts are not hidden", () => {
  const { pill, notice } = resolveShellStatus({ connection: synced, conflictCount: 1 });
  assert.equal(pill.label, "Sync needs a look");
  assert.match(notice.message, /1 change clash/);
  noForbiddenWords(notice.message);
});

test("the service on this computer stopping is an error with a restart offer", () => {
  const { pill, notice } = resolveShellStatus({ connection: resolveConnectionStatus({ cloudReachable: true, localServiceReady: false }), serviceDown: true });
  assert.equal(pill.label, "Service stopped");
  assert.equal(notice.tone, "error");
  assert.equal(notice.offerRestart, true);
  noForbiddenWords(notice.message);
});

test("the cloud server not answering in cloud mode is a warning, never silent", () => {
  // In cloud mode resolveConnectionStatus reports STARTING (localServiceReady is false) and stays
  // quiet, so this panel is the only sentence -- it must be there.
  const connection = resolveConnectionStatus({ cloudReachable: false, localServiceReady: false });
  assert.equal(connection.showsInTopBar, false);
  const { pill, notice } = resolveShellStatus({ connection, serviceDown: true, cloudMode: true, pendingCount: 1 });
  assert.equal(pill.label, "Server not answering");
  assert.equal(notice.tone, "warning");
  assert.equal(notice.offerRestart, false);
  assert.match(notice.message, /1 change saved here/);
  noForbiddenWords(notice.message);
});

test("a startup error is shown as it is, as an error", () => {
  const { notice } = resolveShellStatus({ connection: synced, startupError: "Could not open the local database." });
  assert.deepEqual(notice, { tone: "error", message: "Could not open the local database.", offerRestart: false });
});

test("starting up is calm and says nothing else", () => {
  const { pill, notice } = resolveShellStatus({ connection: resolveConnectionStatus({}), serviceStarting: true, serviceDown: true });
  assert.equal(pill.label, "Starting up");
  assert.equal(notice, null);
});

test("catching up and device approval read in plain words", () => {
  assert.equal(resolveShellStatus({ connection: catchingUp, pendingCount: 2 }).pill.label, "Sending 2");
  assert.equal(resolveShellStatus({ connection: synced, devicePending: true }).pill.label, "Waiting for approval");
});

test("App.jsx: the pill and the panel both come from resolveShellStatus, and the panel has no internal words", () => {
  assert.match(appSource, /const shellStatus = resolveShellStatus\(\{/);
  assert.match(appSource, /<div className="offline-pill" data-tone=\{shellStatus\.pill\.tone\} title=\{shellStatus\.pill\.title \|\| undefined\}>\{shellStatus\.pill\.label\}<\/div>/);
  assert.match(appSource, /\{shellStatus\.notice && \(/);
  const panel = appSource.slice(appSource.indexOf("{shellStatus.notice && ("), appSource.indexOf('{activeView === "dashboard" && !hasModuleAccess("dashboard")'));
  assert.ok(panel.length > 0);
  assert.doesNotMatch(panel, /connectionStatus\.banner|connectionStatus\.detail|API mode/);
  assert.match(panel, /role=\{shellStatus\.notice\.tone === "error" \? "alert" : "status"\}/);
});
