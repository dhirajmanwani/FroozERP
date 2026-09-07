// API mode resolution.
//
// `normalizeApiMode` in App.jsx returns LOCAL_SINGLE_DEVICE for *any* unrecognised input,
// including `undefined`. That made "no configuration" indistinguishable from an explicit
// choice, which is why the desktop legacy-local override fired on every desktop and
// `VITE_API_MODE` was never consulted (audit item 7d).
//
// This module keeps the two apart: `normalizeConfiguredApiMode` returns "" for
// "not configured", and `resolveApiMode` applies precedence over *configured* values only,
// reporting which rung won.

export const UNCONFIGURED_API_MODE = "";

export const API_MODE_VALUES = Object.freeze([
  "HYBRID",
  "LOCAL_ONLY",
  "CLOUD_ONLY",
  "LOCAL_SINGLE_DEVICE",
  "BRANCH_LAN_SERVER",
  "BRANCH_LAN_CLIENT",
  "CLOUD_PRODUCTION",
  "FIELD_REMOTE_DEVICE",
  "CUSTOM_API_URL",
  "SIMULATED_OFFLINE",
]);

const LEGACY_API_MODE_ALIASES = Object.freeze({
  LOCAL_SHOP_SERVER: "LOCAL_SINGLE_DEVICE",
  LOCAL: "LOCAL_ONLY",
  CLOUD: "CLOUD_ONLY",
});

export const CLOUD_CAPABLE_API_MODES = Object.freeze([
  "HYBRID",
  "CLOUD_ONLY",
  "CLOUD_PRODUCTION",
  "FIELD_REMOTE_DEVICE",
]);

/** "" means not configured. It never means LOCAL_SINGLE_DEVICE. */
export const normalizeConfiguredApiMode = (value) => {
  const mode = String(value ?? "").trim().toUpperCase();
  if (!mode) return UNCONFIGURED_API_MODE;
  const aliased = LEGACY_API_MODE_ALIASES[mode] || mode;
  return API_MODE_VALUES.includes(aliased) ? aliased : UNCONFIGURED_API_MODE;
};

export const isConfiguredApiMode = (value) => normalizeConfiguredApiMode(value) !== UNCONFIGURED_API_MODE;

export const isLocalOnlyApiMode = (value) => normalizeConfiguredApiMode(value) === "LOCAL_ONLY";

export const apiModeUsesCloudBackend = (value) =>
  CLOUD_CAPABLE_API_MODES.includes(normalizeConfiguredApiMode(value));

/**
 * Precedence: a Railway-hosted origin, then saved device config, then build env, then the
 * runtime global, then the unconfigured default.
 *
 * The unconfigured desktop default is LOCAL_SINGLE_DEVICE, not HYBRID (ruled: an
 * unconfigured desktop performs no cloud login and no background sync).
 */
export const resolveApiMode = ({
  savedMode,
  envMode,
  globalMode,
  railwayProductionHost = false,
  desktopRuntime = false,
} = {}) => {
  if (railwayProductionHost) return { mode: "CLOUD_PRODUCTION", source: "railway-production-host", configured: true };
  // The saved rung existed to carry the App Mode dropdown's choice. That control is gone -- the app
  // decides for itself whether to use the cloud now -- so on the desktop a saved mode is a decision
  // nobody can revisit, and one machine was already stuck behind it: a `mode: "LOCAL_ONLY"` written
  // by the old "Save Mode" button pinned the app to local-only with no screen left that could
  // change it back. Ignoring it here is self-healing and needs no migration write.
  //
  // A browser keeps the rung: a hosted deployment is still configured deliberately, and there is no
  // desktop shell there to know better.
  const rungs = [
    ...(desktopRuntime ? [] : [["saved-config", savedMode]]),
    ["build-env", envMode],
    ["runtime-global", globalMode],
  ];
  for (const [source, candidate] of rungs) {
    const mode = normalizeConfiguredApiMode(candidate);
    if (mode) return { mode, source, configured: true };
  }
  return {
    mode: desktopRuntime ? "LOCAL_SINGLE_DEVICE" : "LOCAL_ONLY",
    source: "unconfigured-default",
    configured: false,
  };
};

/**
 * API modes that must never be baked into a build that reaches a counter.
 *
 * LOCAL_ONLY is not "this shop is offline today". It is authoritative and permanent: it outranks
 * the connectivity policy the Owner controls (D-16), so `createStartupConnectivityAuthority` never
 * asks the local backend what the policy says, and `confirm()` throws rather than change it. An
 * installation built this way cannot be talked out of it by any file, button or screen on the
 * device -- the only cure is a different build.
 *
 * SIMULATED_OFFLINE is the same shape of mistake: a testing mode that, shipped, makes a working
 * cloud look broken.
 *
 * The supported way to keep a counter off the internet is the kill switch in
 * `cloud-network-policy.json`, which is deliberate, visible and reversible on the device.
 */
export const UNSHIPPABLE_API_MODES = Object.freeze(["LOCAL_ONLY", "SIMULATED_OFFLINE"]);

/**
 * Judge a build-time `VITE_API_MODE` before it becomes a shipped app.
 *
 * ## Why this exists
 *
 * On 2026-09-07 the shop's app reported "Cloud Backend Paused" with the kill switch open, the
 * local service answering `status: AUTO`, and the cloud healthy. It had been built on a machine
 * whose gitignored `frontend/.env.local` still carried `VITE_API_MODE=LOCAL_ONLY` from a test
 * months earlier. Vite bakes that in; the file is in no commit, so no gate, no review and no
 * checkout could see it. Every test passed. The app was simply built wrong, silently, and said
 * only "Local Only" without ever saying where that came from.
 *
 * The parallel with `backend/Dockerfile` is exact and worth stating: both were build-time inputs
 * that the ordinary workflow never looks at, and in both cases everything downstream reported
 * success. The lesson taken there is the one applied here -- make the build itself refuse.
 *
 * ## Not a ban
 *
 * `FROOZERP_ALLOW_LOCAL_ONLY_BUILD=1` still produces one, for the case where somebody genuinely
 * wants a permanently offline build and knows what they are giving up. Impossible by accident,
 * possible on purpose.
 *
 * Pure: takes the value and the acknowledgement, returns a verdict. No env, no process, no exit.
 */
export const describeBuildApiMode = (value, { acknowledged = false } = {}) => {
  const mode = normalizeConfiguredApiMode(value);
  if (!UNSHIPPABLE_API_MODES.includes(mode)) return { ok: true, mode, acknowledged: false };
  // `=== true`, not truthy: a shell variable read the wrong way arrives as the string "0", which
  // is truthy in JavaScript. An escape hatch that opens on "0" is not an escape hatch.
  if (acknowledged === true) return { ok: true, mode, acknowledged: true };
  return {
    ok: false,
    mode,
    acknowledged: false,
    message: [
      `VITE_API_MODE=${mode} would be built into this app permanently.`,
      "",
      mode === "LOCAL_ONLY"
        ? "LOCAL_ONLY outranks the connectivity policy, so the installed app can never be allowed"
        : "SIMULATED_OFFLINE makes a working cloud look broken, and the installed app can never be told",
      "onto the cloud again by any setting, button or file on the device. Only a new build cures it.",
      "",
      "Check frontend/.env.local, frontend/.env.production and your shell for VITE_API_MODE.",
      "These files are gitignored, so nothing else in this repository can see them.",
      "",
      "To keep a counter off the internet, use the kill switch in cloud-network-policy.json instead:",
      "it is deliberate, visible in Settings and reversible on the device.",
      "",
      "If you really do want a permanently offline build, set FROOZERP_ALLOW_LOCAL_ONLY_BUILD=1.",
    ].join("\n"),
  };
};
