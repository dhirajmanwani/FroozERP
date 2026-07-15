import axios from "axios";

const STORAGE_KEY = "froozerp.serverTime.v1";
const DRIFT_LIMIT_MS = 60_000;

const detectedTimeZone = () => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "Unknown";
  } catch {
    return "Unknown";
  }
};

const readStoredState = () => {
  if (typeof window === "undefined" || !window.localStorage) return {};
  try {
    return JSON.parse(window.localStorage.getItem(STORAGE_KEY) || "{}") || {};
  } catch {
    return {};
  }
};

let state = {
  offsetMs: null,
  serverUtcTime: "",
  lastSuccessfulCheckAt: "",
  status: "Offline",
  ...readStoredState(),
};

const persist = () => {
  if (typeof window === "undefined" || !window.localStorage) return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
};

export const canonicalUtcIso = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? "" : date.toISOString();
};

export const formatKolkataDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(date).replace(",", "");
};

export const observeServerTime = ({ serverTime, requestStartedAt, responseReceivedAt = Date.now() }) => {
  const serverMs = new Date(serverTime).getTime();
  const startedMs = Number(requestStartedAt);
  const receivedMs = Number(responseReceivedAt);
  if (!Number.isFinite(serverMs) || !Number.isFinite(startedMs) || !Number.isFinite(receivedMs)) {
    return getTimeDiagnostics();
  }
  const midpointMs = startedMs + ((receivedMs - startedMs) / 2);
  const offsetMs = serverMs - midpointMs;
  state = {
    offsetMs,
    serverUtcTime: canonicalUtcIso(serverMs),
    lastSuccessfulCheckAt: canonicalUtcIso(receivedMs),
    status: Math.abs(offsetMs) > DRIFT_LIMIT_MS ? "Drift detected" : "Synced",
  };
  persist();
  return getTimeDiagnostics();
};

export const markServerTimeOffline = () => {
  state = { ...state, status: "Offline" };
  persist();
  return getTimeDiagnostics();
};

export const checkRailwayServerTime = async (apiUrl, timeoutMs = 5000) => {
  const requestStartedAt = Date.now();
  try {
    const response = await axios.get(`${String(apiUrl || "").replace(/\/$/, "")}/api/time`, {
      timeout: timeoutMs,
      headers: { "Cache-Control": "no-store" },
      params: { t: requestStartedAt },
    });
    return observeServerTime({
      serverTime: response.data?.server_time,
      requestStartedAt,
      responseReceivedAt: Date.now(),
    });
  } catch (error) {
    markServerTimeOffline();
    throw error;
  }
};

export const authoritativeUtcNowIso = () => {
  const offsetMs = Number(state.offsetMs);
  return canonicalUtcIso(Date.now() + (Number.isFinite(offsetMs) ? offsetMs : 0));
};

export const getTimeDiagnostics = () => {
  const now = new Date();
  const offsetMs = Number(state.offsetMs);
  return {
    deviceLocalTime: formatKolkataDateTime(now),
    deviceUtcTime: now.toISOString(),
    railwayServerUtcTime: state.serverUtcTime || "",
    detectedTimezone: detectedTimeZone(),
    clockOffsetSeconds: Number.isFinite(offsetMs) ? Number((offsetMs / 1000).toFixed(3)) : null,
    lastSuccessfulServerTimeCheck: state.lastSuccessfulCheckAt || "",
    timeStatus: state.status || "Offline",
  };
};
