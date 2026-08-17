import {
  CONNECTIVITY_MODES,
  normalizeConnectivityMode,
  writeConnectivityMode,
} from "./connectivityMode.js";
import { isLocalOnlyApiMode } from "./apiModeResolution.js";

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

// `apiMode` is optional and defaults to "not configured". Only the literal value
// "LOCAL_ONLY" changes behaviour: it pins the authority to LOCAL_ONLY permanently, so no
// backend policy and no Owner action can unlock cloud access at runtime. Every other value,
// and the absence of the argument, leaves the pre-existing behaviour exactly as it was.
export const createStartupConnectivityAuthority = ({ desktopRuntime, storage, initialMode, apiMode } = {}) => {
  const apiModeLocalOnly = isLocalOnlyApiMode(apiMode);
  let resolved = apiModeLocalOnly || !desktopRuntime;
  let mode = apiModeLocalOnly || desktopRuntime
    ? CONNECTIVITY_MODES.LOCAL_ONLY
    : normalizeConnectivityMode(initialMode);

  return {
    isResolved: () => resolved,
    getMode: () => mode,
    isApiModeLocalOnly: () => apiModeLocalOnly,
    isLocalOnly: () => apiModeLocalOnly || mode === CONNECTIVITY_MODES.LOCAL_ONLY,
    reconcile(policy) {
      const authoritativeMode = parseBackendPolicy(policy);
      // A malformed policy still throws above, so an invalid backend response can never
      // resolve startup. A valid AUTO policy is accepted for everyone except an installation
      // whose API mode is LOCAL_ONLY, where the mode outranks the policy (D-16).
      mode = apiModeLocalOnly ? CONNECTIVITY_MODES.LOCAL_ONLY : authoritativeMode;
      resolved = true;
      writeConnectivityMode(mode, storage);
      return mode;
    },
    confirm(modeValue) {
      if (apiModeLocalOnly) {
        throw new Error("API_MODE=LOCAL_ONLY is authoritative; connectivity cannot be enabled at runtime.");
      }
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
