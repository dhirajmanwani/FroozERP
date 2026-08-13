import {
  CONNECTIVITY_MODES,
  normalizeConnectivityMode,
  writeConnectivityMode,
} from "./connectivityMode.js";

const parseBackendPolicy = (policy) => {
  if (!policy || typeof policy.allowInternetAccess !== "boolean") {
    throw new Error("The local backend returned an invalid connectivity policy.");
  }
  const mode = normalizeConnectivityMode(policy.status);
  const expectedMode = policy.allowInternetAccess
    ? CONNECTIVITY_MODES.AUTO
    : CONNECTIVITY_MODES.LOCAL_ONLY;
  if (mode !== expectedMode) {
    throw new Error("The local backend returned an inconsistent connectivity policy.");
  }
  return expectedMode;
};

export const createStartupConnectivityAuthority = ({ desktopRuntime, storage, initialMode }) => {
  let resolved = !desktopRuntime;
  let mode = desktopRuntime
    ? CONNECTIVITY_MODES.LOCAL_ONLY
    : normalizeConnectivityMode(initialMode);

  return {
    isResolved: () => resolved,
    getMode: () => mode,
    isLocalOnly: () => mode === CONNECTIVITY_MODES.LOCAL_ONLY,
    reconcile(policy) {
      mode = parseBackendPolicy(policy);
      resolved = true;
      writeConnectivityMode(mode, storage);
      return mode;
    },
    confirm(modeValue) {
      if (!resolved) {
        throw new Error("Connectivity policy must be reconciled before it can be changed.");
      }
      mode = normalizeConnectivityMode(modeValue);
      writeConnectivityMode(mode, storage);
      return mode;
    },
  };
};

export { parseBackendPolicy };
