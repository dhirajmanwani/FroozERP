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
  assert.match(appSource, /Switching\.\.\./);
  assert.match(appSource, /confirmedMode !== nextMode/);
  assert.match(appSource, /data-connectivity-mode="LOCAL_ONLY"/);
  assert.match(appSource, /Return to Auto/);
  assert.doesNotMatch(`${appSource}\n${gatewaySource}`, /netsh|Disable-NetAdapter|Enable-NetAdapter|Windows Firewall|hosts file/i);
  assert.match(gatewaySource, /reachedCloud: false/);
  assert.match(gatewaySource, /timeSource: "railway"/);
});
