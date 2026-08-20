import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * `saveApiConfig` (the "Save Mode" button on Settings → Sync & Connection) has always failed.
 *
 * `desktopGateway.js`'s kill-switch guard only unlocks cloud access for a request that proves
 * Owner role and names the device — it was hardened in auth-hardening's LOCAL_ONLY stage to refuse
 * anything less. `saveApiConfig` sent only `user_id`, so every save was refused with
 * `OWNER_REQUIRED`, "Authenticated Owner permission is required.", regardless of who was signed in.
 * Reproduced on real hardware and confirmed against that exact message before this test was written.
 *
 * `changeConnectivityMode` sends `role` and `device_id` and has always worked — this pins
 * `saveApiConfig` to the same shape, source-text only, since a live gateway isn't available here.
 */

const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

test("saveApiConfig sends role and device_id, not just user_id", () => {
  const start = appSource.indexOf("const saveApiConfig = async () => {");
  assert.notEqual(start, -1, "saveApiConfig must still exist under that name");
  const body = appSource.slice(start, start + 3200);

  assert.match(body, /role:\s*user\.role/, "the gateway guard checks role; omitting it always refuses");
  assert.match(body, /device_id:\s*deviceInfo\.device_id/, "the gateway guard checks device_id too");
  assert.match(body, /"x-user-role":\s*user\.role/);
  assert.match(body, /"x-device-id":\s*deviceInfo\.device_id/);
});
