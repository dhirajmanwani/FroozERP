export const CONNECTIVITY_MODES = Object.freeze({
  AUTO: "AUTO",
  LOCAL_ONLY: "LOCAL_ONLY",
});

export const CONNECTIVITY_MODE_STORAGE_KEY = "froozerp.apiConfig";

export const normalizeConnectivityMode = (value) => {
  const normalized = String(value || "").trim().toUpperCase();
  return ["LOCAL_ONLY", "SIMULATE_OFFLINE"].includes(normalized)
    ? CONNECTIVITY_MODES.LOCAL_ONLY
    : CONNECTIVITY_MODES.AUTO;
};

export const readConnectivityMode = (storage = globalThis.localStorage) => {
  try {
    const config = JSON.parse(storage?.getItem(CONNECTIVITY_MODE_STORAGE_KEY) || "{}") || {};
    return normalizeConnectivityMode(config.connectivityMode || config.cloudConnectionMode);
  } catch {
    return CONNECTIVITY_MODES.AUTO;
  }
};

export const writeConnectivityMode = (mode, storage = globalThis.localStorage) => {
  const nextMode = normalizeConnectivityMode(mode);
  const config = (() => {
    try {
      return JSON.parse(storage?.getItem(CONNECTIVITY_MODE_STORAGE_KEY) || "{}") || {};
    } catch {
      return {};
    }
  })();
  storage?.setItem(CONNECTIVITY_MODE_STORAGE_KEY, JSON.stringify({
    ...config,
    connectivityMode: nextMode,
    cloudConnectionMode: nextMode === CONNECTIVITY_MODES.LOCAL_ONLY ? "SIMULATE_OFFLINE" : "ONLINE",
  }));
  return nextMode;
};

export const connectivityModeMessage = (mode) => (
  normalizeConnectivityMode(mode) === CONNECTIVITY_MODES.LOCAL_ONLY
    ? "Local Only mode selected - cloud sync paused"
    : "Auto mode selected - local services and cloud sync are available"
);
