import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  SETTINGS_WRITE_FAILURE,
  describeSettingsWriteFailure,
  refreshAfterSaveMessage,
  settingsWriteErrorMessage,
} from "./settingsWriteError.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");

const responded = (status, data) => ({ response: { status, data } });

test("a server that answered is never reported as no connection", () => {
  // The whole evening of 2026-09-17 in one assertion. The cloud was reachable, the policy open,
  // the version right — and a 400 about a missing rate was shown as "no connection to the cloud",
  // so the search went looking for a network fault that did not exist.
  const failure = describeSettingsWriteFailure(
    responded(400, { message: "Enter a rate for this charge" }),
    "Unable to add this charge",
    { browserReportsOffline: true },
  );
  assert.equal(failure.reason, SETTINGS_WRITE_FAILURE.SERVER_REFUSED);
  assert.equal(failure.message, "Enter a rate for this charge");
  assert.doesNotMatch(failure.message, /connection|offline|reconnect/i);
});

test("navigator.onLine cannot overrule any answer, at any status", () => {
  for (const status of [400, 401, 403, 404, 409, 422, 500, 502]) {
    const failure = describeSettingsWriteFailure(
      responded(status, { message: `server said ${status}` }),
      "Unable to save",
      { browserReportsOffline: true },
    );
    assert.equal(failure.message, `server said ${status}`, `status ${status} was overruled`);
  }
});

test("silence is the only thing read as an outage", () => {
  const failure = describeSettingsWriteFailure(new Error("Network Error"), "Unable to add this charge");
  assert.equal(failure.reason, SETTINGS_WRITE_FAILURE.NO_REPLY);
  assert.match(failure.message, /no reply at all/);
  assert.match(failure.message, /Billing and everything else keep working offline/);
});

test("Windows saying it is offline colours the no-reply case and nothing else", () => {
  const quiet = describeSettingsWriteFailure(new Error("Network Error"), "Unable to save", { browserReportsOffline: false });
  const claimed = describeSettingsWriteFailure(new Error("Network Error"), "Unable to save", { browserReportsOffline: true });
  assert.doesNotMatch(quiet.message, /Windows reports/);
  assert.match(claimed.message, /Windows reports it is offline/);
});

test("the three refusals that arrive as an answer are told apart", () => {
  const paused = describeSettingsWriteFailure(responded(503, { code: "APP_LOCAL_ONLY" }), "Unable to save");
  assert.equal(paused.reason, SETTINGS_WRITE_FAILURE.CLOUD_PAUSED);
  assert.match(paused.message, /switched off for this machine/);
  assert.match(paused.message, /Sync & Connection/, "it must say where the switch is");
  assert.doesNotMatch(paused.message, /reconnect/i, "reconnecting does nothing when the Owner paused it");

  const unconfigured = describeSettingsWriteFailure(responded(503, { code: "CLOUD_NOT_CONFIGURED" }), "Unable to save");
  assert.equal(unconfigured.reason, SETTINGS_WRITE_FAILURE.CLOUD_NOT_CONFIGURED);
  assert.match(unconfigured.message, /no cloud address/);
  assert.doesNotMatch(unconfigured.message, /reconnect/i, "there is nothing to reconnect to");

  const down = describeSettingsWriteFailure(responded(503, { code: "CLOUD_UNAVAILABLE", message: "Cloud is down." }), "Unable to save");
  assert.equal(down.reason, SETTINGS_WRITE_FAILURE.CLOUD_UNAVAILABLE);
  assert.match(down.message, /Cloud is down\./);
});

test("nothing was saved is said in every branch, because that is the question being asked", () => {
  const cases = [
    describeSettingsWriteFailure(new Error("Network Error"), "Unable to add this charge"),
    describeSettingsWriteFailure(responded(503, { code: "APP_LOCAL_ONLY" }), "Unable to add this charge"),
    describeSettingsWriteFailure(responded(503, { code: "CLOUD_NOT_CONFIGURED" }), "Unable to add this charge"),
  ];
  for (const failure of cases) {
    assert.match(failure.message, /nothing was sent|no reply at all|nowhere to save/i, failure.message);
  }
});

test("a thrown non-axios error still produces a sentence rather than [object Object]", () => {
  for (const thrown of [null, undefined, "boom", 42, {}, new TypeError("x is not a function")]) {
    const message = settingsWriteErrorMessage(thrown, "Unable to add this charge");
    assert.equal(typeof message, "string");
    assert.ok(message.startsWith("Unable to add this charge"), message);
  }
});

test("a missing fallback still names what happened", () => {
  const message = settingsWriteErrorMessage(new Error("Network Error"), "");
  assert.match(message, /^That change could not be saved/);
});

test("App.jsx uses this module and keeps no second copy of the rule", () => {
  assert.match(appSource, /settingsWriteErrorMessage/, "App.jsx must call the shared rule");
  assert.doesNotMatch(
    appSource,
    /navigator\.onLine === false\s*\)?\s*;?\s*\n?\s*if \(offline/,
    "the old inline rule must be gone, not left beside the new one",
  );
});

test("a no-reply failure names the underlying reason instead of swallowing it", () => {
  // "No reply" has several causes that look identical from outside: the network, a request the
  // webview refused to make, a bug that threw before anything was sent. The one string that can
  // tell them apart is the thrown error's own message, and it used to be discarded here.
  const network = describeSettingsWriteFailure(new Error("Network Error"), "Unable to add this charge");
  assert.match(network.message, /\[Network Error\]$/);
  assert.equal(network.detail, "Network Error");

  const blocked = describeSettingsWriteFailure(new TypeError("Failed to fetch"), "Unable to add this charge");
  assert.match(blocked.message, /\[Failed to fetch\]$/);

  // A throw with nothing to say must not leave an empty bracket dangling.
  const bare = describeSettingsWriteFailure({}, "Unable to add this charge");
  assert.doesNotMatch(bare.message, /\[\]/);
});

// ---------------------------------------------------------------------------------------------
// The save worked; the refresh did not
// ---------------------------------------------------------------------------------------------

test("a failed refresh says the save is safe, and never says the save failed", () => {
  // The actual evening of 2026-09-17: "Unable to add this rate" about a rate that was added,
  // twice, leaving the shop's crate charge with the same slab listed twice.
  const message = refreshAfterSaveMessage(new Error("Network Error"));
  assert.match(message, /Anything you just saved is saved/);
  assert.match(message, /may be showing old information/);
  assert.doesNotMatch(message, /unable|could not save|failed to save/i);
  assert.match(message, /\[Network Error\]$/);
});

test("the settings refresh never rejects, and never fails one read because another failed", () => {
  // The fix is in App.jsx because that is where onReload is built. Both halves matter: allSettled
  // so one bad read does not fail the other two, and no rethrow so a write handler awaiting this
  // inside its own try cannot be blamed for it.
  const anchor = appSource.indexOf("loadSettingsData(), loadPurchaseRules(), loadDiscountRules()");
  assert.notEqual(anchor, -1, "the Settings reload bundle is gone");
  const reload = appSource.slice(appSource.lastIndexOf("onReload={async () => {", anchor), appSource.indexOf("onRegisterCloudDevice=", anchor));
  assert.match(reload, /Promise\.allSettled\(/, "one failed read must not fail the refresh");
  assert.doesNotMatch(reload, /Promise\.all\(/, "Promise.all rejects the whole refresh on any single failure");
  assert.match(reload, /refreshAfterSaveMessage\(/, "a failed refresh must still be reported, as itself");
  assert.doesNotMatch(reload, /throw\b/, "a rejection here is reported by twenty handlers as a failed save");
});

test("every settings write that reloads inside its own try is covered by that guarantee", () => {
  // This is the count that made the one-line fix the right one: twenty handlers share the shape
  //     await axios.post(...); await onReload();  } catch { alert("Unable to ...") }
  // and each would otherwise need its own correction. If this number grows, the new handler has
  // the same shape and is protected by the same guarantee — which is why this asserts a floor and
  // not an exact number.
  const pattern = /await onReload\(\);\s*\}\s*catch/g;
  const count = (appSource.match(pattern) || []).length;
  assert.ok(count >= 15, `expected the shared shape to still be widespread, found ${count}`);
});
