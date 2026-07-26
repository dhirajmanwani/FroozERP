import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const appSource = fs.readFileSync(path.join(here, "..", "App.jsx"), "utf8");

test("fresh desktop login uses cloud before an offline cache exists", () => {
  const loginStart = appSource.indexOf("const login = async () =>");
  const loginEnd = appSource.indexOf("const retryOnline = async () =>", loginStart);
  const loginSource = appSource.slice(loginStart, loginEnd);
  assert.ok(loginStart > 0 && loginEnd > loginStart);
  assert.match(loginSource, /axios\.post\(`\$\{AUTH_API_URL\}\/login`/);
  assert.match(loginSource, /\/api\/auth\/device-bootstrap-status/);
  assert.match(loginSource, /normalizeDeviceBootstrapStatus/);
  assert.match(loginSource, /DEVICE_PENDING_APPROVAL/);
  assert.match(loginSource, /await hydrateOnlineSession\(response\.data, latestDevice\)/);
});

test("successful approved-device login provisions a device-bound offline session", () => {
  const hydrateStart = appSource.indexOf("const hydrateOnlineSession = async");
  const hydrateEnd = appSource.indexOf("const continueOffline = async", hydrateStart);
  const hydrateSource = appSource.slice(hydrateStart, hydrateEnd);
  assert.match(hydrateSource, /initialPullForApprovedDevice\(\{/);
  assert.match(hydrateSource, /branchId: currentUser\?\.branch_id/);
  assert.match(hydrateSource, /cacheOfflineSession\(\{/);
  assert.match(hydrateSource, /deviceId: latestDevice\.device_id/);
  assert.match(hydrateSource, /cacheLocalReferenceSnapshot\(\{/);
  assert.match(hydrateSource, /offline_auth: offlineSession/);
});

test("fresh onboarding performs a pull-only cycle before provisioning", () => {
  const syncSource = fs.readFileSync(path.join(here, "syncService.js"), "utf8");
  const start = syncSource.indexOf("export async function initialPullForApprovedDevice");
  const end = syncSource.indexOf("export function getNextRetryDelay", start);
  const initialPullSource = syncSource.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(initialPullSource, /await initialiseSync\(/);
  assert.match(initialPullSource, /await pullServerChanges\(/);
  assert.doesNotMatch(initialPullSource, /pushPendingOperations\(/);
  assert.match(initialPullSource, /INITIAL_PULL_ACKNOWLEDGED/);
});

test("device identity is generated per installation without machine-specific constants", () => {
  assert.match(appSource, /crypto\?\.randomUUID\?\.\(\)/);
  assert.doesNotMatch(appSource, /FZDEV-SECOND-LAPTOP/);
});

test("pending approval is shown distinctly from invalid credentials", () => {
  assert.match(appSource, /Device awaiting owner approval\./);
  assert.match(appSource, /deviceGate\.code === "DEVICE_PENDING_APPROVAL"/);
  assert.match(appSource, /Device ID: \{deviceGate\.device_id \|\| deviceInfo\.device_id\}/);
});

test("retry online rechecks approval instead of reporting health alone", () => {
  const retryStart = appSource.indexOf("const retryOnline = async () =>");
  const retryEnd = appSource.indexOf("const activateDevice = async", retryStart);
  const retrySource = appSource.slice(retryStart, retryEnd);
  assert.match(retrySource, /\/api\/auth\/device-bootstrap-status/);
  assert.match(retrySource, /Device approval confirmed/);
  assert.match(retrySource, /return await login\(\)/);
  assert.match(retrySource, /Device awaiting owner approval/);
});

test("desktop cloud onboarding fails closed when SQLite identity is unavailable", () => {
  const resolverStart = appSource.indexOf("const resolveLocalDeviceInfo = async");
  const resolverEnd = appSource.indexOf("const normalizeApiMode", resolverStart);
  const resolverSource = appSource.slice(resolverStart, resolverEnd);
  assert.match(resolverSource, /throw new Error\("The local device identity is not ready/);
  assert.doesNotMatch(resolverSource, /if \(!identity\?\.device_id\) return fallback/);
});

test("approved canonical credential failure preserves an existing offline session", () => {
  const loginStart = appSource.indexOf("const login = async () =>");
  const loginEnd = appSource.indexOf("const retryOnline = async () =>", loginStart);
  const loginSource = appSource.slice(loginStart, loginEnd);
  assert.match(loginSource, /approvedDeviceCredentialMessage/);
  assert.match(loginSource, /const opened = await continueOffline\(latestDevice\)/);
  assert.match(loginSource, /if \(opened\) return/);
});
