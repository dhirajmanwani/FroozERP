import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { autoConnectivityBlockedReason } from "./autoConnectivityAvailability.js";

test("AUTO is unavailable when App Mode pins the device to Local Only", () => {
  // The reported failure: pressing AUTO on such an installation throws
  // "API_MODE=LOCAL_ONLY is authoritative" every time, by design. The button should never have been
  // pressable.
  const reason = autoConnectivityBlockedReason({ apiMode: "LOCAL_ONLY" });
  assert.notEqual(reason, "");
  // It used to have to name "App Mode" -- the setting that controlled this. There is no such
  // setting any more, so naming it would send the reader hunting for a control that was deleted.
  // What the sentence must still do is say the state is deliberate and that the shop is fine.
  assert.match(reason, /on purpose/i, "the reason must say this is deliberate, not a fault");
  assert.match(reason, /saved on this computer/i, "and that nothing is being lost meanwhile");
  assert.doesNotMatch(reason, /App Mode|Cloud API URL|Connectivity Mode/i, "and must not name a deleted control");
});

test("AUTO is unavailable when no cloud backend is configured", () => {
  // The same dead end one step later: AUTO would be accepted and sync would have nowhere to go,
  // surfacing as a sync error rather than as the configuration gap it is.
  const reason = autoConnectivityBlockedReason({ apiMode: "CLOUD_PRODUCTION", cloudApiUrl: "" });
  assert.match(reason, /no cloud to connect to/i);
  assert.match(reason, /Billing works normally/i, "the shop must be told it can keep selling");
  assert.doesNotMatch(reason, /Set a Cloud API URL/i, "that box no longer exists to set");

  for (const cloudApiUrl of [undefined, null, "   "]) {
    assert.notEqual(autoConnectivityBlockedReason({ apiMode: "CLOUD_PRODUCTION", cloudApiUrl }), "");
  }
});

test("AUTO is available once a cloud-capable mode has somewhere to connect", () => {
  assert.equal(
    autoConnectivityBlockedReason({ apiMode: "CLOUD_PRODUCTION", cloudApiUrl: "https://api.example.com" }),
    "",
  );
});

test("the reason is plain language, with no code or setting names from the source", () => {
  // The maintainer asked for language a shop user can act on; the underlying throw reads
  // "API_MODE=LOCAL_ONLY is authoritative; connectivity cannot be enabled at runtime."
  const reason = autoConnectivityBlockedReason({ apiMode: "LOCAL_ONLY" });
  assert.doesNotMatch(reason, /API_MODE|authoritative|runtime|CONNECTIVITY_MODES|D-16/i);
});

test("a reason is returned rather than a boolean, so a disabled control always carries its why", () => {
  // A disabled button with no explanation is the same dead end with better manners. Returning the
  // sentence makes it impossible for the caller to have one without the other.
  assert.equal(typeof autoConnectivityBlockedReason({ apiMode: "LOCAL_ONLY" }), "string");
  assert.equal(typeof autoConnectivityBlockedReason({}), "string");
});

test("the reconnect control is disabled by this reason, and the reason is shown", () => {
  // Pins the wiring: the control must be disabled, not merely refused on click, and the same
  // sentence must appear on screen rather than only in a tooltip.
  //
  // There were two such controls -- an AUTO button in Settings and a "Return to Auto" button on the
  // banner -- and the rule had to be repeated for each. There is one now: the banner's "Reconnect
  // this computer", shown only when somebody has deliberately held this machine off the cloud.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(
    app,
    /disabled=\{connectivityModeSwitching \|\| bannerAutoBlockedReason !== ""\}/,
    "the reconnect button must be disabled when the reason is non-empty",
  );
  assert.match(
    app,
    /\{bannerAutoBlockedReason && <span>\{bannerAutoBlockedReason\}<\/span>\}/,
    "the reason must be rendered, not hidden in a title attribute",
  );
});
