import axios from "axios";

const DEFAULT_TIMEOUT_MS = 3500;

let latestState = {
  apiUrl: "",
  url: "",
  online: null,
  checking: false,
  reason: "initial",
  reasonCode: "NOT_CHECKED",
  status: null,
  message: "Backend reachability has not been checked yet.",
  lastCheckedAt: "",
  lastOnlineAt: "",
  lastErrorAt: "",
};

let inFlight = null;
let inFlightController = null;
const listeners = new Set();

const healthUrl = (apiUrl) => `${String(apiUrl || "").replace(/\/$/, "")}/api/health`;

const isTauriRuntime = () =>
  typeof window !== "undefined" && (Boolean(window.__TAURI_INTERNALS__) || Boolean(window.__TAURI__));

const writeConnectivityLog = async (level, message, details = {}) => {
  const entry = `[FroozERP connectivity] ${message} ${JSON.stringify(details)}`;
  console.info(entry);
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("app_log", { level, message: entry });
  } catch {
    // Console logging remains available in browser/dev mode.
  }
};

const classifyHealthError = (error) => {
  if (axios.isCancel?.(error) || error.name === "CanceledError" || error.code === "ERR_CANCELED") {
    return { reasonCode: "ABORTED", message: "Previous health check was cancelled." };
  }
  if (error.code === "ECONNABORTED") {
    return { reasonCode: "TIMEOUT", message: "FroozERP backend health check timed out." };
  }
  if (error.response) {
    return {
      reasonCode: "HTTP_FAILURE",
      message: error.response.data?.message || `FroozERP backend returned HTTP ${error.response.status}.`,
    };
  }
  if (error.message?.toLowerCase().includes("network")) {
    return { reasonCode: "NO_NETWORK", message: "Network is available to Windows, but FroozERP backend is unreachable." };
  }
  return { reasonCode: "BACKEND_UNAVAILABLE", message: error.message || "FroozERP backend is unavailable." };
};

const emit = () => {
  for (const listener of listeners) listener(latestState);
};

export const getConnectivitySnapshot = () => latestState;

export const subscribeConnectivity = (listener) => {
  listeners.add(listener);
  listener(latestState);
  return () => listeners.delete(listener);
};

export async function checkFroozBackendHealth(apiUrl, options = {}) {
  const normalizedApiUrl = String(apiUrl || "").replace(/\/$/, "");
  const url = healthUrl(normalizedApiUrl);
  const reason = options.reason || "manual";
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  writeConnectivityLog("INFO", "health-check-start", { apiUrl: normalizedApiUrl, endpoint: url, reason });

  if (inFlight && !options.force) return inFlight;
  if (inFlightController && options.force) inFlightController.abort();

  inFlightController = new AbortController();
  latestState = {
    ...latestState,
    apiUrl: normalizedApiUrl,
    url,
    checking: true,
    reason,
    message: `Checking FroozERP service at ${url}...`,
  };
  emit();

  inFlight = (async () => {
    try {
      const response = await axios.get(url, {
        timeout: timeoutMs,
        signal: inFlightController.signal,
        headers: { "Cache-Control": "no-cache" },
        params: { t: Date.now() },
      });
      const online = response.data?.status === "ok";
      latestState = {
        apiUrl: normalizedApiUrl,
        url,
        online,
        checking: false,
        reason,
        reasonCode: online ? "ONLINE" : "HTTP_FAILURE",
        status: response.status,
        message: online ? "FroozERP backend is reachable." : "Health endpoint responded but did not report ok.",
        data: response.data,
        lastCheckedAt: new Date().toISOString(),
        lastOnlineAt: online ? new Date().toISOString() : latestState.lastOnlineAt,
        lastErrorAt: online ? latestState.lastErrorAt : new Date().toISOString(),
      };
      writeConnectivityLog("INFO", "health-check-result", {
        apiUrl: normalizedApiUrl,
        endpoint: url,
        reason,
        online,
        status: response.status,
      });
      return latestState;
    } catch (error) {
      const classified = classifyHealthError(error);
      latestState = {
        ...latestState,
        apiUrl: normalizedApiUrl,
        url,
        online: false,
        checking: false,
        reason,
        reasonCode: classified.reasonCode,
        status: error.response?.status || null,
        message: classified.message,
        lastCheckedAt: new Date().toISOString(),
        lastErrorAt: new Date().toISOString(),
      };
      writeConnectivityLog("ERROR", "health-check-failed", {
        apiUrl: normalizedApiUrl,
        endpoint: url,
        reason,
        reasonCode: classified.reasonCode,
        status: error.response?.status || null,
        message: classified.message,
      });
      return latestState;
    } finally {
      inFlight = null;
      inFlightController = null;
      emit();
    }
  })();

  return inFlight;
}

export const connectivityEventNames = ["online", "offline", "focus", "pageshow", "visibilitychange"];
