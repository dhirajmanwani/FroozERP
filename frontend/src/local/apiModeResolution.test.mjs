import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  UNCONFIGURED_API_MODE,
  UNSHIPPABLE_API_MODES,
  apiModeUsesCloudBackend,
  describeBuildApiMode,
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

/**
 * The build must refuse to bake a permanently offline app.
 *
 * ## What happened
 *
 * On 2026-09-07 the shop's app reported "Cloud Backend Paused" while the kill switch was open, the
 * local service answered `status: AUTO`, and the cloud was healthy and reachable. Nothing on the
 * device was wrong. The build was: it carried `VITE_API_MODE=LOCAL_ONLY`, baked in from a
 * gitignored `frontend/.env.local` written months earlier for a test.
 *
 * LOCAL_ONLY outranks the connectivity policy by design (D-16), so the app never asked the local
 * backend what the policy said, and no file, button or screen on the device could undo it. The one
 * cure was a different build -- and the app only ever said "Local Only", never where that came from.
 *
 * ## Why a test could not have caught it, and why the check lives in vite.config.js
 *
 * Every gate passed. `.env.local` is in no commit, so no test, no review and no checkout can see
 * it; the value only exists at the moment Vite runs. The check therefore has to be part of the
 * build itself. This file pins both halves: the decision, and that the build actually consults it.
 *
 * The parallel with backend/Dockerfile is exact: a build-time input the ordinary workflow never
 * looks at, with everything downstream reporting success.
 */
test("a build refuses the modes that can never be undone on the device", () => {
  for (const mode of UNSHIPPABLE_API_MODES) {
    const verdict = describeBuildApiMode(mode);
    assert.equal(verdict.ok, false, `${mode} must not ship silently`);
    assert.equal(verdict.mode, mode);
    // The message has to name the file nobody can see from the repository, or the reader is left
    // exactly where this evening started: a true statement and no way to act on it.
    assert.match(verdict.message, /\.env\.local/);
    assert.match(verdict.message, /cloud-network-policy\.json/, "and must name the supported alternative");
  }
});

test("every ordinary mode builds, including the unconfigured one", () => {
  // A guard that blocks a normal build is worse than no guard: it would be switched off.
  for (const mode of ["", "LOCAL_SINGLE_DEVICE", "HYBRID", "CLOUD_PRODUCTION", "BRANCH_LAN_CLIENT", "nonsense"]) {
    assert.equal(describeBuildApiMode(mode).ok, true, `${mode || "(unset)"} must build`);
  }
});

test("a deliberate offline build is still possible, and says so", () => {
  // Impossible by accident, possible on purpose. Removing the capability outright would be a
  // different kind of wrong -- and the acknowledgement is what makes it a decision rather than a
  // leftover.
  const verdict = describeBuildApiMode("LOCAL_ONLY", { acknowledged: true });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.acknowledged, true);
});

test("the acknowledgement cannot be given by accident", () => {
  // Only `acknowledged: true`. A truthy string from a shell variable read the wrong way must not
  // count, or the escape hatch becomes the default.
  assert.equal(describeBuildApiMode("LOCAL_ONLY", { acknowledged: "0" }).ok, false, "\"0\" is truthy in JS and must not unlock this");
  assert.equal(describeBuildApiMode("LOCAL_ONLY", { acknowledged: 1 }).ok, false);
  assert.equal(describeBuildApiMode("LOCAL_ONLY", {}).ok, false);
  assert.equal(describeBuildApiMode("LOCAL_ONLY").ok, false);
});

test("the build actually consults the decision, and refuses on it", () => {
  // The decision above is inert unless vite.config.js calls it and throws. Both halves, because a
  // guard nobody invokes is indistinguishable from no guard -- and this one cannot be caught by a
  // runtime test, since by then the wrong value is already compiled in.
  const config = fs.readFileSync(new URL("../../vite.config.js", import.meta.url), "utf8");
  assert.match(config, /import \{ describeBuildApiMode \} from/);
  assert.match(config, /command === 'build'/, "a dev server is somebody at a keyboard; only a build ships");
  assert.match(config, /loadEnv\(mode, process\.cwd\(\), ''\)/, "must read the same files Vite itself reads, .env.local included");
  assert.match(config, /if \(!verdict\.ok\) throw/, "a warning would scroll past; this has to stop the build");
});

test("the app records which rung decided its mode", () => {
  // "Local Only" was true and unactionable. The cause has to travel with the state, in the two
  // places somebody actually looks: the copyable diagnostics and the startup log.
  const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /apiModeSource: API_MODE_RESOLUTION\.source/);
  assert.match(app, /appModeSource: connectionStatus\?\.apiModeSource/, "must sit in the copyable diagnostics");
  assert.match(app, /"api-mode-resolved"/, "and be written down at startup");
  // Logged unconditionally. The connectivity-policy line is not: LOCAL_ONLY skips that effect
  // entirely, so its absence was the only trace the fault left, and an absence is not evidence.
  assert.match(app, /outranksConnectivityPolicy: startupConnectivityAuthority\.isApiModeLocalOnly\(\)/);
});
