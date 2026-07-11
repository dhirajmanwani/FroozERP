import axios from "axios";
import { checkFroozBackendHealth, getConnectivitySnapshot } from "./connectivityService";
import { isTauriRuntime } from "./localDatabase";
import { repositories } from "./repositories";

let runningSync = null;
let backoffMs = 2000;
let lastStatus = {
  online: false,
  syncing: false,
  lastError: "",
  lastPushAt: "",
  lastPullAt: "",
  lastSuccessfulSyncAt: "",
  currentCursor: "",
  pendingOperations: 0,
  failedOperations: 0,
  conflictOperations: 0,
  apiUrl: "",
  backendUrl: "",
  lastFailureKind: "",
  lastHttpStatus: null,
  syncStage: "",
  syncProgressDone: 0,
  syncProgressTotal: 0,
};

const clampBackoff = () => {
  backoffMs = Math.min(backoffMs * 2, 60_000);
};

const resetBackoff = () => {
  backoffMs = 2000;
};

const withTimeout = (timeoutMs = 10000) => ({
  timeout: timeoutMs,
});

const normalizeApiUrl = (apiUrl) => String(apiUrl || "").replace(/\/$/, "");

const endpointUrl = (apiUrl, path) => `${normalizeApiUrl(apiUrl)}${path}`;

const isRailwayProductionHost = () => {
  if (typeof window === "undefined" || !window.location) return false;
  return String(window.location.hostname || "").toLowerCase().endsWith(".up.railway.app");
};

const getCurrentOrigin = () => {
  if (typeof window === "undefined" || !window.location) return "";
  return normalizeApiUrl(window.location.origin || `${window.location.protocol}//${window.location.host}`);
};

const readSavedApiConfig = () => {
  const defaults = {
    mode: String(import.meta.env.VITE_API_MODE || "HYBRID").trim().toUpperCase(),
    companyId: String(import.meta.env.VITE_COMPANY_ID || "").trim(),
    branchId: String(import.meta.env.VITE_BRANCH_ID || "1").trim(),
    subBranchId: String(import.meta.env.VITE_SUB_BRANCH_ID || "").trim(),
    deviceId: String(import.meta.env.VITE_DEVICE_ID || "").trim(),
    deviceName: String(import.meta.env.VITE_DEVICE_NAME || "").trim(),
    cloudApiUrl: normalizeApiUrl(import.meta.env.VITE_CLOUD_API_URL || "https://froozerp-production.up.railway.app"),
    branchLanApiUrl: normalizeApiUrl(import.meta.env.VITE_BRANCH_LAN_API_URL || ""),
    customApiUrl: normalizeApiUrl(import.meta.env.VITE_CUSTOM_API_URL || ""),
  };
  if (typeof window === "undefined" || !window.localStorage) return defaults;
  try {
    const saved = JSON.parse(window.localStorage.getItem("froozerp.apiConfig") || "{}") || {};
    if (isRailwayProductionHost()) {
      return {
        ...defaults,
        ...saved,
        mode: "CLOUD_PRODUCTION",
        cloudApiUrl: getCurrentOrigin(),
      };
    }
    return { ...defaults, ...saved };
  } catch {
    return isRailwayProductionHost()
      ? { ...defaults, mode: "CLOUD_PRODUCTION", cloudApiUrl: getCurrentOrigin() }
      : defaults;
  }
};

const writeSyncLog = async (level, message, details = {}) => {
  const entry = `[FroozERP sync] ${message} ${JSON.stringify(details)}`;
  console.info(entry);
  if (!isTauriRuntime()) return;
  try {
    const { invoke } = await import("@tauri-apps/api/core");
    await invoke("app_log", { level, message: entry });
  } catch {
    // Console logging remains available in browser/dev mode.
  }
};

const normalizeLocalStatus = (status = {}) => ({
  ...lastStatus,
  lastPushAt: status.lastPushAt || lastStatus.lastPushAt,
  lastPullAt: status.lastPullAt || lastStatus.lastPullAt,
  lastSuccessfulSyncAt: status.lastSuccessfulSyncAt || lastStatus.lastSuccessfulSyncAt,
  currentCursor: status.currentCursor || lastStatus.currentCursor || "0",
  pendingOperations: Number(status.pendingOperations || 0),
  failedOperations: Number(status.failedOperations || 0),
  conflictOperations: Number(status.conflictOperations || 0),
  lastError: status.error || "",
});

const classifySyncError = (error) => {
  const status = error.response?.status || null;
  const serverMessage = error.response?.data?.message || error.response?.data?.error;
  if (status) {
    if (status === 401) {
      return {
        online: true,
        kind: "AUTHORIZATION",
        message: `Authorisation required - ${serverMessage || "sync user session is not valid."}`,
        status,
      };
    }
    if (status === 403) {
      return {
        online: true,
        kind: "DEVICE_AUTHORIZATION",
        message: `Authorisation required - ${serverMessage || "device is not authorised for sync."}`,
        status,
      };
    }
    if (status === 404) {
      return {
        online: true,
        kind: "WRONG_ENDPOINT",
        message: `Sync failed - endpoint not found (${status}). Check the sync API route and API base.`,
        status,
      };
    }
    if (status === 409) {
      return {
        online: true,
        kind: "CONFLICT",
        message: `Conflict - ${serverMessage || "server reported a sync conflict."}`,
        status,
      };
    }
    return {
      online: true,
      kind: status >= 500 ? "SERVER_ERROR" : "HTTP_ERROR",
      message: `Sync failed - ${serverMessage || `backend returned HTTP ${status}.`}`,
      status,
    };
  }
  if (error.code === "ECONNABORTED") {
    return { online: false, kind: "TIMEOUT", message: "Offline - backend sync request timed out.", status: null };
  }
  const message = typeof error === "string" ? error : error.message || "Sync failed";
  const networkFailure = /network|refused|failed to fetch|timeout|unreachable|offline/i.test(message);
  return {
    online: !networkFailure,
    kind: networkFailure ? "BACKEND_UNREACHABLE" : "CLIENT_ERROR",
    message: networkFailure ? `Offline - backend unreachable (${message})` : `Sync failed - ${message}`,
    status: null,
  };
};

const logSyncEndpoint = (phase, apiUrl, path, extra = {}) => {
  writeSyncLog("INFO", "endpoint", {
    phase,
    apiUrl: normalizeApiUrl(apiUrl),
    endpoint: endpointUrl(apiUrl, path),
    ...extra,
  });
};

const syncContext = ({ user, deviceInfo, branchId }) => ({
  userId: user?.id,
  deviceId: deviceInfo?.device_id,
  deviceName: deviceInfo?.device_name,
  branchId: String(branchId || user?.branch_id || 1),
});

export async function checkBackendHealth(apiUrl, options = {}) {
  const health = await checkFroozBackendHealth(apiUrl, options);
  return options.details ? health : health.online;
}

export async function initialiseSync({ apiUrl, user, deviceInfo, branchId }) {
  const localStatus = await repositories.status.get();
  lastStatus = normalizeLocalStatus(localStatus);
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const apiConfig = readSavedApiConfig();
  const requireCloudIdentity = ["HYBRID", "CLOUD_ONLY", "CLOUD_PRODUCTION", "FIELD_REMOTE_DEVICE"].includes(apiConfig.mode);
  const health = await checkBackendHealth(apiUrl, { details: true, reason: "sync-initialise", requireCloudIdentity });
  lastStatus = {
    ...lastStatus,
    online: Boolean(health.online),
    apiUrl: health.apiUrl || normalizeApiUrl(apiUrl),
    backendUrl: health.url || endpointUrl(apiUrl, "/api/health"),
    lastFailureKind: health.online ? "" : health.reasonCode,
    lastHttpStatus: health.httpStatus || null,
    lastError: health.online ? "" : health.message,
  };
  if (!health.online) return lastStatus;
  logSyncEndpoint("register-device", apiUrl, "/api/sync/register-device", { deviceId: context.deviceId });
  await axios.post(endpointUrl(apiUrl, "/api/sync/register-device"), {
    device_id: context.deviceId,
    device_name: context.deviceName || "FroozERP Device",
    platform: "tauri-windows",
    app_version: String(import.meta.env.VITE_APP_VERSION || "1.0.33"),
    branch_id: context.branchId,
    user_id: context.userId,
    role: user?.role_name || user?.role || "",
    app_mode: apiConfig.mode || "",
    company_id: apiConfig.companyId || "",
    sub_branch_id: apiConfig.subBranchId || "",
    cloud_api_url: apiConfig.cloudApiUrl || "",
    branch_lan_api_url: apiConfig.branchLanApiUrl || "",
    custom_api_url: apiConfig.customApiUrl || "",
  }, withTimeout());
  return lastStatus;
}

export async function pushPendingOperations({ apiUrl, user, deviceInfo, branchId }) {
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const operations = await repositories.outbox.pending(50);
  if (operations.length === 0) {
    writeSyncLog("INFO", "push-skipped", {
      apiUrl: normalizeApiUrl(apiUrl),
      endpoint: endpointUrl(apiUrl, "/api/sync/push"),
      reason: "no-pending-operations",
    });
    return normalizeLocalStatus(await repositories.status.get());
  }
  logSyncEndpoint("push", apiUrl, "/api/sync/push", { count: operations.length });
  lastStatus = {
    ...lastStatus,
    syncStage: "push",
    syncProgressDone: 0,
    syncProgressTotal: operations.length,
  };
  const response = await axios.post(endpointUrl(apiUrl, "/api/sync/push"), {
    user_id: context.userId,
    device_id: context.deviceId,
    branch_id: context.branchId,
    client_timestamp: new Date().toISOString(),
    operations: operations.map((operation) => ({
      operation_id: operation.operation_id,
      idempotency_key: operation.operation_id,
      entity_type: operation.entity_type,
      entity_id: operation.entity_id,
      operation_type: operation.operation_type,
      version: operation.version,
      payload: operation.payload,
      created_at: operation.created_at,
    })),
  }, withTimeout(15000));
  writeSyncLog("INFO", "push-result", {
    apiUrl: normalizeApiUrl(apiUrl),
    endpoint: endpointUrl(apiUrl, "/api/sync/push"),
    status: response.status,
    operationCount: operations.length,
    acknowledgementCount: (response.data?.acknowledgements || []).length,
  });
  const status = await repositories.outbox.applyAcks(response.data?.acknowledgements || []);
  lastStatus = {
    ...normalizeLocalStatus(status),
    online: true,
    lastError: "",
    apiUrl: normalizeApiUrl(apiUrl),
    syncStage: "push",
    syncProgressDone: operations.length,
    syncProgressTotal: operations.length,
  };
  return lastStatus;
}

export async function pullServerChanges({ apiUrl, user, deviceInfo, branchId }) {
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const localStatus = await repositories.status.get();
  const cursor = localStatus.currentCursor || "0";
  logSyncEndpoint("pull", apiUrl, "/api/sync/pull", { cursor });
  const response = await axios.get(endpointUrl(apiUrl, "/api/sync/pull"), {
    ...withTimeout(15000),
    params: {
      user_id: context.userId,
      device_id: context.deviceId,
      branch_id: context.branchId,
      cursor,
      limit: 50,
    },
  });
  writeSyncLog("INFO", "pull-result", {
    apiUrl: normalizeApiUrl(apiUrl),
    endpoint: endpointUrl(apiUrl, "/api/sync/pull"),
    status: response.status,
    changeCount: (response.data?.changes || []).length,
    nextCursor: response.data?.next_cursor || cursor,
    hasMore: Boolean(response.data?.has_more),
  });
  const status = await applyPulledChanges({
    changes: response.data?.changes || [],
    nextCursor: response.data?.next_cursor || cursor,
    deviceId: context.deviceId,
  });
  lastStatus = { ...normalizeLocalStatus(status), online: true, lastError: "", apiUrl: normalizeApiUrl(apiUrl), syncStage: "pull" };
  return { ...lastStatus, hasMore: Boolean(response.data?.has_more) };
}

export async function applyPulledChanges({ changes, nextCursor, deviceId }) {
  return repositories.pull.apply({ changes, nextCursor, deviceId });
}

export async function retryFailedOperations() {
  const status = await repositories.outbox.retryFailed();
  lastStatus = normalizeLocalStatus(status);
  return lastStatus;
}

export async function getSyncStatus() {
  if (!isTauriRuntime()) return lastStatus;
  const status = await repositories.status.get();
  lastStatus = normalizeLocalStatus(status);
  return lastStatus;
}

export async function syncNow({ apiUrl, user, deviceInfo, branchId }) {
  if (runningSync) return runningSync;
  runningSync = (async () => {
    lastStatus = { ...lastStatus, syncing: true, lastError: "", apiUrl: normalizeApiUrl(apiUrl), syncStage: "starting" };
    try {
      await initialiseSync({ apiUrl, user, deviceInfo, branchId });
      if (!lastStatus.online) {
        const offlineError = new Error(lastStatus.lastError || getConnectivitySnapshot().message || "Offline - backend unreachable");
        offlineError.froozConnectivity = true;
        throw offlineError;
      }
      await pushPendingOperations({ apiUrl, user, deviceInfo, branchId });
      let pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
      while (pullStatus.hasMore) {
        pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
      }
      resetBackoff();
      lastStatus = { ...lastStatus, syncing: false, online: true, lastError: "", syncStage: "idle", syncProgressDone: 0, syncProgressTotal: 0 };
      return lastStatus;
    } catch (error) {
      clampBackoff();
      const classified = classifySyncError(error);
      const message = classified.message;
      writeSyncLog(classified.online ? "WARN" : "ERROR", "sync-failed", {
        apiUrl: normalizeApiUrl(apiUrl),
        backendUrl: endpointUrl(apiUrl, "/api/health"),
        stage: lastStatus.syncStage || "unknown",
        kind: classified.kind,
        status: classified.status || null,
        message,
      });
      const status = await repositories.status.fail(message);
      lastStatus = {
        ...normalizeLocalStatus(status),
        syncing: false,
        online: classified.online,
        lastError: message,
        lastFailureKind: classified.kind,
        lastHttpStatus: classified.status,
        apiUrl: normalizeApiUrl(apiUrl),
        backendUrl: endpointUrl(apiUrl, "/api/health"),
        syncStage: "failed",
      };
      return lastStatus;
    } finally {
      runningSync = null;
    }
  })();
  return runningSync;
}

export function getNextRetryDelay() {
  return backoffMs;
}

export async function queueSafeSyncTest({ value, user, deviceInfo, branchId }) {
  const entityId = `phase2-test-${Date.now()}`;
  await repositories.syncTest.queue({
    entityId,
    value,
    branchId: String(branchId || user?.branch_id || 1),
    deviceId: deviceInfo?.device_id,
    userId: user?.id ? String(user.id) : "",
  });
  return entityId;
}
