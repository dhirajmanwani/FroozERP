import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { plainServerMessage } from "./plainServerMessage.js";

const appSource = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const backendScope = readFileSync(new URL("../../../backend/operationalScope.js", import.meta.url), "utf8");

test("the no-first-counter refusal asks for the maintainer instead of naming a script", () => {
  const server = "No counter has been set up yet, so nothing can be saved from any computer. The first counter is created once with scripts/bootstrap-first-counter.mjs (docs/first-counter-setup.md), for this computer: dev-123. Then sign out and back in.";
  const shown = plainServerMessage(server);
  assert.equal(shown, "No counter has been set up yet, so nothing can be saved from any computer. Ask the maintainer to set up the first counter. Then sign out and back in.");
  assert.doesNotMatch(shown, /scripts\/|docs\/|\.mjs/);
});

test("the unposted-computer refusal keeps the part a person can act on", () => {
  const server = "This computer (dev-9) is not posted to any counter, so nothing can be saved from it. Post it to a counter in Branches & Counters from a computer that is, or with scripts/approve-device.mjs --counter.";
  assert.equal(
    plainServerMessage(server),
    "This computer (dev-9) is not posted to any counter, so nothing can be saved from it. Post it to a counter in Branches & Counters from a computer that is.",
  );
});

test("every other message passes through untouched", () => {
  for (const message of ["Consignments could not be loaded", "Stock is short by 2.500 kg.", "", "Rate is 12.50."]) {
    assert.equal(plainServerMessage(message), message);
  }
  assert.equal(plainServerMessage(undefined), undefined);
  assert.equal(plainServerMessage(null), null);
});

test("the backend still emits the script-path sentences this module exists for", () => {
  // If the backend rewords these, this test says so, rather than the rewrite silently going stale.
  assert.match(backendScope, /scripts\/bootstrap-first-counter\.mjs \(docs\/first-counter-setup\.md\)/);
  assert.match(backendScope, /or with scripts\/approve-device\.mjs --counter\./);
});

test("App.jsx: server error text is passed through plainServerMessage", () => {
  assert.match(appSource, /import \{ plainServerMessage \} from "\.\/local\/plainServerMessage";/);
  assert.match(appSource, /const getErrorMessage = \(error, fallback\) =>\s*plainServerMessage\(error\.response\?\.data\?\.message\) \|\| fallback;/);
});
