const normalizeApiUrl = (apiUrl) => String(apiUrl || "").replace(/\/$/, "");

const isHostedCloudApi = (apiUrl) => {
  try {
    const parsed = new URL(normalizeApiUrl(apiUrl));
    return parsed.protocol === "https:" && !["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
  } catch {
    return false;
  }
};

export const classifySyncError = (error, apiUrl = "") => {
  const status = error.response?.status || null;
  const serverMessage = error.response?.data?.message || error.response?.data?.error;
  const cloudRequest = isHostedCloudApi(apiUrl);
  if (status) {
    if (status === 401) {
      return { online: true, kind: "AUTHORIZATION", message: `Authorisation required - ${serverMessage || "sync user session is not valid."}`, status };
    }
    if (status === 403) {
      return { online: true, kind: "DEVICE_AUTHORIZATION", message: `Authorisation required - ${serverMessage || "device is not authorised for sync."}`, status };
    }
    if (status === 404) {
      return { online: true, kind: "WRONG_ENDPOINT", message: `Sync failed - endpoint not found (${status}). Check the sync API route and API base.`, status };
    }
    if (status === 409) {
      return { online: true, kind: "CONFLICT", message: `Conflict - ${serverMessage || "server reported a sync conflict."}`, status };
    }
    return {
      online: true,
      kind: status >= 500 ? "SERVER_ERROR" : "HTTP_ERROR",
      message: `Sync failed - ${serverMessage || `backend returned HTTP ${status}.`}`,
      status,
    };
  }
  if (error.code === "ECONNABORTED") {
    return {
      online: false,
      kind: "TIMEOUT",
      message: cloudRequest ? "Cloud temporarily unavailable - sync request timed out." : "Local FroozERP sync request timed out.",
      status: null,
    };
  }
  const message = typeof error === "string" ? error : error.message || "Sync failed";
  const networkFailure = /network|refused|failed to fetch|timeout|unreachable|offline/i.test(message);
  return {
    online: !networkFailure,
    kind: networkFailure ? (cloudRequest ? "CLOUD_UNAVAILABLE" : "BACKEND_UNREACHABLE") : "CLIENT_ERROR",
    message: networkFailure
      ? cloudRequest ? "Cloud temporarily unavailable - sync paused until internet returns." : `Local FroozERP service unreachable (${message})`
      : `Sync failed - ${message}`,
    status: null,
  };
};
