import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

/**
 * Every request that moves this device on or off the cloud must prove who is asking.
 *
 * ## The original failure
 *
 * `desktopGateway.js`'s kill-switch guard only unlocks cloud access for a request that proves Owner
 * role and names the device — hardened that way in auth-hardening's LOCAL_ONLY stage, so anything
 * less is refused. `saveApiConfig`, behind the "Save Mode" button, sent only `user_id`. Every save
 * was therefore refused with `OWNER_REQUIRED`, "Authenticated Owner permission is required.",
 * regardless of who was signed in. Reproduced on real hardware before this test was written.
 *
 * ## Why this file now reads differently
 *
 * "Save Mode" is gone, and so is `saveApiConfig`: the modes it saved no longer exist, because the
 * app decides for itself whether to use the cloud (see `local/connectionStatus.js`). Deleting a
 * caller does not retire the rule it broke, though — it just leaves one caller instead of two.
 *
 * So this checks the rule rather than the caller: **whatever calls that route must send role and
 * device_id.** That is strictly stronger than the original, which pinned one function by name and
 * would have said nothing about a third caller added tomorrow.
 */

const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

/** Every PUT to the kill-switch route, with enough of its call site to see what it sends. */
const internetAccessWrites = () => {
  const calls = [];
  const marker = 'axios.put(`${LOCAL_API_URL}/api/cloud/internet-access`';
  for (let at = appSource.indexOf(marker); at !== -1; at = appSource.indexOf(marker, at + 1)) {
    calls.push(appSource.slice(at, at + 700));
  }
  return calls;
};

test("the kill-switch route still has a caller, so this file is not silently passing on nothing", () => {
  // Without this, deleting the last caller would turn every assertion below into a vacuous truth
  // and the suite would go green on an app that could no longer be locked down at all.
  assert.ok(internetAccessWrites().length >= 1, "some code must still be able to change cloud access");
});

test("every caller proves Owner role and names the device, in the body and in the headers", () => {
  for (const [index, body] of internetAccessWrites().entries()) {
    assert.match(body, /role:\s*user\.role/, `call ${index}: the gateway guard checks role; omitting it always refuses`);
    assert.match(body, /device_id:\s*deviceInfo\.device_id/, `call ${index}: the gateway guard checks device_id too`);
    assert.match(body, /"x-user-role":\s*user\.role/, `call ${index}: header form`);
    assert.match(body, /"x-device-id":\s*deviceInfo\.device_id/, `call ${index}: header form`);
  }
});

test("the surviving caller refuses non-Owners before it reaches the network", () => {
  // Belt and braces, and the braces matter: relying on the gateway alone means a Cashier's click
  // produces a refusal that reads like a fault rather than a permission.
  const start = appSource.indexOf("const changeConnectivityMode");
  assert.notEqual(start, -1, "changeConnectivityMode must still exist under that name");
  const body = appSource.slice(start, start + 1200);
  assert.match(body, /!== "OWNER"[\s\S]*throw new Error/, "a non-Owner must be turned away locally");
});

test("nothing in the app writes a connection mode into saved config any more", () => {
  // `saveApiConfig` persisted eight fields and reloaded the page to apply them. Its return would
  // reintroduce exactly the thing the maintainer ruled out: a screen where somebody chooses what
  // "connected" means, and four settings then have to agree for the shop to work.
  assert.doesNotMatch(appSource, /const saveApiConfig\b/, "the Save Mode handler must stay gone");
  assert.doesNotMatch(appSource, /API_MODE_OPTIONS\.map/, "and the App Mode picker with it");
});
