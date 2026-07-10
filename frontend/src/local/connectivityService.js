import axios from "axios";

const DEFAULT_TIMEOUT_MS = 3500;

let latestState = {
  apiUrl: "",
  url: "",
  online: null,
  checking: false,
  reachabilityStatus: "checking",
  reason: "initial",
  reasonCode: "NOT_CHECKED",
  status: "checking",
  httpStatus: null,
  message: "Backend reachability has not been checked yet.",
  lastCheckedAt: "",
  lastOnlineAt: "",
  lastErrorAt: "",
  requestId: 0,
};

let inFlight = null;
let inFlightController = null;
let latestRequestId = 0;
const listeners = new Set();

const healthUrl = (apiUrl) => `${String(apiUrl || "").replace(/\/$/, "")}/api/health`;

const hasExpectedCloudIdentity = (data = {}) =>
  data.app === "FroozERP"
  && String(data.api_version) === "1"
  && Boolean(data.version)
  && data.deployment_type === "cloud";

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
    return { reasonCode: "ABORTED", reachabilityStatus: "checking", message: "Previous health check was cancelled." };
  }
  if (error.code === "ECONNABORTED") {
    return { reasonCode: "TIMEOUT", reachabilityStatus: "timeout", message: "FroozERP backend health check timed out." };
  }
  if (error.response) {
    const status = error.response.status;
    if (status === 401) {
      return {
        reasonCode: "AUTHORIZATION",
        reachabilityStatus: "unauthorised",
        message: error.response.data?.message || "FroozERP backend is reachable, but the session is not authorised.",
      };
    }
    if (status === 403) {
      return {
        reasonCode: "DEVICE_AUTHORIZATION",
        reachabilityStatus: "unauthorised",
        message: error.response.data?.message || "FroozERP backend is reachable, but this device is not authorised.",
      };
    }
    return {
      reasonCode: status >= 500 ? "SERVER_ERROR" : "HTTP_FAILURE",
      reachabilityStatus: status >= 500 ? "server_error" : "offline",
      message: error.response.data?.message || `FroozERP backend returned HTTP ${status}.`,
    };
  }
  if (error.message?.toLowerCase().includes("network")) {
    return { reasonCode: "NO_NETWORK", reachabilityStatus: "offline", message: "Network is available to Windows, but FroozERP backend is unreachable." };
  }
  return { reasonCode: "BACKEND_UNAVAILABLE", reachabilityStatus: "offline", message: error.message || "FroozERP backend is unavailable." };
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

  const requestId = latestRequestId + 1;
  latestRequestId = requestId;
  inFlightController = new AbortController();
  latestState = {
    ...latestState,
    apiUrl: normalizedApiUrl,
    url,
    checking: true,
    reachabilityStatus: "checking",
    status: "checking",
    requestId,
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
      if (requestId !== latestRequestId) return latestState;
      const healthOk = response.data?.status === "ok";
      const cloudIdentityValid = !options.requireCloudIdentity || hasExpectedCloudIdentity(response.data);
      const online = healthOk && cloudIdentityValid;
      const reasonCode = online
        ? "ONLINE"
        : healthOk && options.requireCloudIdentity
          ? "CLOUD_IDENTITY_INVALID"
          : "HTTP_FAILURE";
      const message = online
        ? options.requireCloudIdentity ? "FroozERP cloud backend is reachable and identified." : "FroozERP backend is reachable."
        : healthOk && options.requireCloudIdentity
          ? "Backend responded, but it is not configured as a valid FroozERP cloud deployment."
          : "Health endpoint responded but did not report ok.";
      latestState = {
        apiUrl: normalizedApiUrl,
        url,
        online,
        checking: false,
        reachabilityStatus: online ? "online" : "server_error",
        reason,
        reasonCode,
        status: online ? "online" : "server_error",
        httpStatus: response.status,
        message,
        data: response.data,
        lastCheckedAt: new Date().toISOString(),
        lastOnlineAt: online ? new Date().toISOString() : latestState.lastOnlineAt,
        lastErrorAt: online ? latestState.lastErrorAt : new Date().toISOString(),
        requestId,
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
      if (requestId !== latestRequestId || classified.reasonCode === "ABORTED") {
        return latestState;
      }
      latestState = {
        ...latestState,
        apiUrl: normalizedApiUrl,
        url,
        online: false,
        checking: false,
        reachabilityStatus: classified.reachabilityStatus,
        status: classified.reachabilityStatus,
        reason,
        reasonCode: classified.reasonCode,
        httpStatus: error.response?.status || null,
        message: classified.message,
        lastCheckedAt: new Date().toISOString(),
        lastErrorAt: new Date().toISOString(),
        requestId,
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
      if (requestId === latestRequestId) {
        inFlight = null;
        inFlightController = null;
        emit();
      }
    }
  })();

  return inFlight;
}

export const connectivityEventNames = ["online", "offline", "focus", "pageshow", "visibilitychange"];
