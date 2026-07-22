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
  assert.match(loginSource, /DEVICE_PENDING_APPROVAL/);
  assert.match(loginSource, /await hydrateOnlineSession\(response\.data, latestDevice\)/);
});

test("successful approved-device login provisions a device-bound offline session", () => {
  const hydrateStart = appSource.indexOf("const hydrateOnlineSession = async");
  const hydrateEnd = appSource.indexOf("const continueOffline = async", hydrateStart);
  const hydrateSource = appSource.slice(hydrateStart, hydrateEnd);
  assert.match(hydrateSource, /cacheOfflineSession\(\{/);
  assert.match(hydrateSource, /deviceId: latestDevice\.device_id/);
  assert.match(hydrateSource, /cacheLocalReferenceSnapshot\(\{/);
  assert.match(hydrateSource, /offline_auth: offlineSession/);
});

test("pending approval is shown distinctly from invalid credentials", () => {
  assert.match(appSource, /Device awaiting owner approval\./);
  assert.match(appSource, /deviceGate\.code === "DEVICE_PENDING_APPROVAL"/);
  assert.match(appSource, /Device ID: \{deviceGate\.device_id \|\| deviceInfo\.device_id\}/);
});
