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
