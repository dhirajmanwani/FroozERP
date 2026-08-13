import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

import { CONNECTIVITY_MODES } from "./connectivityMode.js";
import { createStartupConnectivityAuthority } from "./startupConnectivityPolicy.js";

const createStorage = (value = {}) => {
  let serialized = JSON.stringify(value);
  return {
    getItem: () => serialized,
    setItem: (_key, next) => { serialized = next; },
    read: () => JSON.parse(serialized),
  };
};

test("desktop startup stays local-only until the backend policy is authoritative", () => {
  const storage = createStorage({ connectivityMode: "AUTO", cloudConnectionMode: "ONLINE" });
  const authority = createStartupConnectivityAuthority({ desktopRuntime: true, storage });

  assert.equal(authority.isResolved(), false);
  assert.equal(authority.isLocalOnly(), true);
  assert.equal(authority.getMode(), CONNECTIVITY_MODES.LOCAL_ONLY);
  assert.equal(storage.read().connectivityMode, "AUTO");

  assert.equal(authority.reconcile({ allowInternetAccess: false, status: "LOCAL_ONLY" }), CONNECTIVITY_MODES.LOCAL_ONLY);
  assert.equal(authority.isResolved(), true);
  assert.equal(storage.read().connectivityMode, "LOCAL_ONLY");
  assert.equal(storage.read().cloudConnectionMode, "SIMULATE_OFFLINE");
});

test("an authoritative AUTO policy replaces stale or malformed frontend state", () => {
  const storage = createStorage({ connectivityMode: "not-a-mode", cloudConnectionMode: "LOCAL_ONLY" });
  const authority = createStartupConnectivityAuthority({ desktopRuntime: true, storage });

  assert.equal(authority.reconcile({ allowInternetAccess: true, status: "AUTO" }), CONNECTIVITY_MODES.AUTO);
  assert.equal(authority.isLocalOnly(), false);
  assert.equal(storage.read().connectivityMode, "AUTO");
  assert.equal(storage.read().cloudConnectionMode, "ONLINE");
});

test("invalid backend policy cannot unlock cloud-capable startup", () => {
  const authority = createStartupConnectivityAuthority({ desktopRuntime: true, storage: createStorage({ connectivityMode: "AUTO" }) });

  assert.throws(() => authority.reconcile({ status: "AUTO" }), /invalid connectivity policy/);
  assert.throws(() => authority.reconcile({ allowInternetAccess: false, status: "AUTO" }), /inconsistent connectivity policy/);
  assert.equal(authority.isResolved(), false);
  assert.equal(authority.isLocalOnly(), true);
});

test("an authorized confirmed transition works only after reconciliation", () => {
  const storage = createStorage();
  const authority = createStartupConnectivityAuthority({ desktopRuntime: true, storage });

  assert.throws(() => authority.confirm(CONNECTIVITY_MODES.AUTO), /must be reconciled/);
  authority.reconcile({ allowInternetAccess: false, status: "LOCAL_ONLY" });
  assert.equal(authority.confirm(CONNECTIVITY_MODES.AUTO), CONNECTIVITY_MODES.AUTO);
  assert.equal(storage.read().connectivityMode, "AUTO");
});

test("non-desktop runtimes retain their configured connectivity mode", () => {
  const local = createStartupConnectivityAuthority({ desktopRuntime: false, storage: createStorage(), initialMode: "LOCAL_ONLY" });
  const automatic = createStartupConnectivityAuthority({ desktopRuntime: false, storage: createStorage(), initialMode: "AUTO" });

  assert.equal(local.isResolved(), true);
  assert.equal(local.isLocalOnly(), true);
  assert.equal(automatic.getMode(), CONNECTIVITY_MODES.AUTO);
});

test("packaged startup gates every cloud-capable scheduler until backend reconciliation", () => {
  const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

  assert.match(appSource, /if \(user \|\| !connectivityPolicyReady\) return undefined;/);
  assert.match(appSource, /if \(!connectivityPolicyReady\) return undefined;[\s\S]*runConnectivityCheck\("startup"/);
  assert.match(appSource, /const localOnly = isLocalOnlyConnectivitySelected\(\);[\s\S]*const realInternet = localOnly \? browserOnline/);
  assert.match(appSource, /usesCloudBackend\(\) && !localOnly[\s\S]*checkCloudBackendHealth/);
  assert.match(appSource, /!localOnly && health\.online && cloudReadyForSync/);
  assert.match(appSource, /backendHealth\.online && !isLocalOnlyConnectivitySelected\(\)/);
  assert.match(appSource, /axios\.get\(`\$\{LOCAL_API_URL\}\/api\/cloud\/internet-access`/);
  assert.match(appSource, /window\.setTimeout\(reconcileWithRetry, 1000\)/);
});
