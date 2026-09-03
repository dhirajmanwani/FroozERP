import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { CONNECTIVITY_MODES, normalizeConnectivityMode, readConnectivityMode, writeConnectivityMode } from "./connectivityMode.js";

const memoryStorage = (initial = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (key) => values.get(key) || null, setItem: (key, value) => values.set(key, value) };
};

test("legacy simulated offline migrates to Local Only", () => {
  assert.equal(normalizeConnectivityMode("SIMULATE_OFFLINE"), CONNECTIVITY_MODES.LOCAL_ONLY);
});

test("twenty Auto and Local Only transitions persist without touching system networking", () => {
  const storage = memoryStorage();
  for (let index = 0; index < 20; index += 1) {
    const expected = index % 2 ? CONNECTIVITY_MODES.AUTO : CONNECTIVITY_MODES.LOCAL_ONLY;
    writeConnectivityMode(expected, storage);
    assert.equal(readConnectivityMode(storage), expected);
  }
});

test("Local Only is owner controlled, audited, prominent, and never changes Windows networking", () => {
  const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const gatewaySource = fs.readFileSync(new URL("../../../backend/desktopGateway.js", import.meta.url), "utf8");
  assert.match(appSource, /Only Owner may change Connectivity Mode/);
  assert.match(appSource, /recordConnectivityModeChange/);
  assert.match(appSource, /Reconnecting\.\.\./, "the switch must show that it is working");
  assert.match(appSource, /confirmedMode !== nextMode/);

  // These three used to pin the exact words "Local Only mode selected" and "Return to Auto", and a
  // `data-connectivity-mode` attribute. All three are gone with the mode vocabulary: a shopkeeper
  // reading "Local Only mode selected" on a machine where nobody selected anything learns nothing,
  // and goes looking for the setting that did it.
  //
  // What the test protects is unchanged and is not about wording: a machine held off the cloud must
  // *say so unmissably*, must be identifiable in the DOM, and must offer a way back. So the
  // guarantee is now pinned to `local/connectionStatus.js`, which owns the sentence and is tested
  // for its content there.
  assert.match(appSource, /data-connection-state=\{connectionSentence\.state\}/, "the banner must carry the state");
  assert.match(appSource, /connectionSentence\.showsInTopBar && \(/, "and must appear without anybody opening a panel");
  assert.match(appSource, /Reconnect this computer/, "and there must be a way back");
  assert.match(appSource, /connectionSentence\.tone === CONNECTION_TONE\.ATTENTION/, "shown only where it applies");
  assert.doesNotMatch(`${appSource}\n${gatewaySource}`, /netsh|Disable-NetAdapter|Enable-NetAdapter|Windows Firewall|hosts file/i);
  assert.match(gatewaySource, /reachedCloud: false/);
  assert.match(gatewaySource, /timeSource: "railway"/);
});
