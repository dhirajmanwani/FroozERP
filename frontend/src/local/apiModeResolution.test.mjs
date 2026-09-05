import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  UNCONFIGURED_API_MODE,
  apiModeUsesCloudBackend,
  isConfiguredApiMode,
  isLocalOnlyApiMode,
  normalizeConfiguredApiMode,
  resolveApiMode,
} from "./apiModeResolution.js";

test("an absent or unrecognised mode is 'not configured', not LOCAL_SINGLE_DEVICE", () => {
  for (const value of [undefined, null, "", "   ", "NOT_A_MODE", 0]) {
    assert.equal(normalizeConfiguredApiMode(value), UNCONFIGURED_API_MODE);
    assert.equal(isConfiguredApiMode(value), false);
  }
  assert.equal(normalizeConfiguredApiMode("local_single_device"), "LOCAL_SINGLE_DEVICE");
  assert.equal(isConfiguredApiMode("LOCAL_SINGLE_DEVICE"), true);
});

test("legacy mode aliases still resolve", () => {
  assert.equal(normalizeConfiguredApiMode("LOCAL_SHOP_SERVER"), "LOCAL_SINGLE_DEVICE");
  assert.equal(normalizeConfiguredApiMode("local"), "LOCAL_ONLY");
  assert.equal(normalizeConfiguredApiMode("Cloud"), "CLOUD_ONLY");
});

test("VITE_API_MODE is consulted when no mode is saved on the device", () => {
  // Previously unreachable on desktop: the saved-mode rung always produced
  // LOCAL_SINGLE_DEVICE, which the legacy desktop override then forced to HYBRID.
  assert.deepEqual(
    resolveApiMode({ savedMode: undefined, envMode: "LOCAL_ONLY", desktopRuntime: true }),
    { mode: "LOCAL_ONLY", source: "build-env", configured: true },
  );
  assert.deepEqual(
    resolveApiMode({ savedMode: "", envMode: "", globalMode: "BRANCH_LAN_CLIENT", desktopRuntime: true }),
    { mode: "BRANCH_LAN_CLIENT", source: "runtime-global", configured: true },
  );
});

test("a saved mode outranks build env, and a Railway origin outranks everything", () => {
  assert.equal(resolveApiMode({ savedMode: "BRANCH_LAN_SERVER", envMode: "HYBRID" }).mode, "BRANCH_LAN_SERVER");
  assert.deepEqual(
    resolveApiMode({ savedMode: "LOCAL_ONLY", envMode: "LOCAL_ONLY", railwayProductionHost: true }),
    { mode: "CLOUD_PRODUCTION", source: "railway-production-host", configured: true },
  );
});

test("an unconfigured desktop is LOCAL_SINGLE_DEVICE, and an unconfigured browser is LOCAL_ONLY", () => {
  // Ruled: with no saved mode a desktop no longer performs cloud login or background sync.
  assert.deepEqual(
    resolveApiMode({ desktopRuntime: true }),
    { mode: "LOCAL_SINGLE_DEVICE", source: "unconfigured-default", configured: false },
  );
  assert.deepEqual(
    resolveApiMode({ desktopRuntime: false }),
    { mode: "LOCAL_ONLY", source: "unconfigured-default", configured: false },
  );
  assert.deepEqual(resolveApiMode(), { mode: "LOCAL_ONLY", source: "unconfigured-default", configured: false });
});

test("cloud capability is a property of the mode, and LOCAL_ONLY is never cloud capable", () => {
  for (const mode of ["HYBRID", "CLOUD_ONLY", "CLOUD_PRODUCTION", "FIELD_REMOTE_DEVICE"]) {
    assert.equal(apiModeUsesCloudBackend(mode), true);
  }
  for (const mode of ["LOCAL_ONLY", "LOCAL_SINGLE_DEVICE", "BRANCH_LAN_SERVER", "BRANCH_LAN_CLIENT", "", undefined]) {
    assert.equal(apiModeUsesCloudBackend(mode), false);
  }
  assert.equal(isLocalOnlyApiMode("local"), true);
  assert.equal(isLocalOnlyApiMode("LOCAL_SINGLE_DEVICE"), false);
});

test("App.jsx resolves the API mode before the connectivity authority and has no desktop override", () => {
  const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

  assert.doesNotMatch(appSource, /legacyDesktopLocalMode/);
  assert.doesNotMatch(
    appSource,
    /isDesktopShell\(\) \? API_MODES\.HYBRID : API_MODES\.LOCAL_ONLY/,
    "The unconfigured desktop default must no longer be HYBRID",
  );
  assert.match(appSource, /const API_MODE_RESOLUTION = resolveApiMode\(\{[\s\S]*envMode: import\.meta\.env\.VITE_API_MODE/);
  assert.match(appSource, /const API_MODE = normalizeApiMode\(API_MODE_RESOLUTION\.mode\);/);

  // Ordering matters: the authority is constructed with the mode, so the mode must exist first.
  const modeIndex = appSource.indexOf("const API_MODE = normalizeApiMode(API_MODE_RESOLUTION.mode);");
  const authorityIndex = appSource.indexOf("const startupConnectivityAuthority = createStartupConnectivityAuthority(");
  assert.ok(modeIndex > 0 && authorityIndex > modeIndex, "API_MODE must be resolved before the connectivity authority");
  assert.match(appSource.slice(authorityIndex, authorityIndex + 400), /apiMode: API_MODE,/);
});

test("a saved mode is ignored on the desktop, because the control that wrote it is gone", () => {
  // The App Mode dropdown was removed on 2026-09-03. A mode it had saved then became unreachable:
  // the maintainer's own machine carried `mode: "LOCAL_ONLY"` from an old "Save Mode" press, which
  // pinned the app to local-only with no screen left that could change it back.
  //
  // Ignoring the rung is self-healing -- nothing has to be migrated or rewritten -- and it is only
  // safe because the desktop's unconfigured default is a real, working mode.
  assert.deepEqual(
    resolveApiMode({ savedMode: "LOCAL_ONLY", desktopRuntime: true }),
    { mode: "LOCAL_SINGLE_DEVICE", source: "unconfigured-default", configured: false },
  );

  // Build-time configuration still wins over the ignored saved value, so a deliberately built
  // installation is unaffected.
  assert.equal(
    resolveApiMode({ savedMode: "LOCAL_ONLY", envMode: "CLOUD_PRODUCTION", desktopRuntime: true }).mode,
    "CLOUD_PRODUCTION",
  );
});

test("a browser still honours a saved mode", () => {
  // There is no shell there to know better, and a hosted deployment is configured deliberately.
  assert.deepEqual(
    resolveApiMode({ savedMode: "BRANCH_LAN_SERVER", envMode: "HYBRID", desktopRuntime: false }),
    { mode: "BRANCH_LAN_SERVER", source: "saved-config", configured: true },
  );
});
