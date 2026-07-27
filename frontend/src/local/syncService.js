import axios from "axios";
import { checkFroozBackendHealth, getConnectivitySnapshot } from "./connectivityService";
import { isTauriRuntime } from "./localDatabase";
import { repositories } from "./repositories";
import { classifySyncError } from "./syncClassification";
import {
  authoritativeUtcNowIso,
  checkRailwayServerTime,
  getTimeDiagnostics,
  markServerTimeOffline,
  observeServerTime,
} from "./serverTime";

let runningSync = null;
let backoffMs = 2000;
let lastStatus = {
  online: false,
  syncing: false,
  lastError: "",
  lastPushAt: "",
  lastPullAt: "",
  lastPushResult: "",
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
  canonicalIdentity: null,
  timeDiagnostics: getTimeDiagnostics(),
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
const LEGACY_PRODUCTION_CLOUD_API_URLS = new Set(["https://froozerp-production.up.railway.app"]);
const DEFAULT_PRODUCTION_CLOUD_API_URL = "https://froozerp-production-27bb.up.railway.app";
const canonicalizeCloudApiUrl = (apiUrl) => {
  const normalized = normalizeApiUrl(apiUrl);
  return LEGACY_PRODUCTION_CLOUD_API_URLS.has(normalized) ? DEFAULT_PRODUCTION_CLOUD_API_URL : normalized;
};

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
    cloudApiUrl: canonicalizeCloudApiUrl(import.meta.env.VITE_CLOUD_API_URL || DEFAULT_PRODUCTION_CLOUD_API_URL),
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
    return { ...defaults, ...saved, cloudApiUrl: canonicalizeCloudApiUrl(saved.cloudApiUrl || defaults.cloudApiUrl) };
  } catch {
    return isRailwayProductionHost()
      ? { ...defaults, mode: "CLOUD_PRODUCTION", cloudApiUrl: getCurrentOrigin() }
      : defaults;
  }
};

const cloudAccessDisabledByOwner = () => {
  const config = readSavedApiConfig();
  return ["LOCAL_ONLY", "SIMULATE_OFFLINE"].includes(String(config.connectivityMode || config.cloudConnectionMode || "").trim().toUpperCase());
};

const simulatedOfflineStatus = async (apiUrl, stage = "sync") => {
  const localStatus = await repositories.status.get();
  lastStatus = {
    ...normalizeLocalStatus(localStatus),
    online: false,
    syncing: false,
    apiUrl: normalizeApiUrl(apiUrl),
    backendUrl: endpointUrl(apiUrl, "/api/health"),
    lastFailureKind: "APP_LOCAL_ONLY",
    lastHttpStatus: null,
    syncStage: stage,
    lastError: "Local Only mode selected - cloud sync paused.",
  };
  return lastStatus;
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
  lastPushResult: status.lastPushResult || lastStatus.lastPushResult,
  lastSuccessfulSyncAt: status.lastSuccessfulSyncAt || lastStatus.lastSuccessfulSyncAt,
  currentCursor: status.currentCursor || lastStatus.currentCursor || "0",
  pendingOperations: Number(status.pendingOperations || 0),
  failedOperations: Number(status.failedOperations || 0),
  conflictOperations: Number(status.conflictOperations || 0),
  lastError: status.error || "",
  timeDiagnostics: getTimeDiagnostics(),
});

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
  branchId: String(branchId || user?.branch_id || ""),
  deviceSessionToken: user?.device_session_token || "",
});

export async function checkBackendHealth(apiUrl, options = {}) {
  const health = await checkFroozBackendHealth(apiUrl, options);
  return options.details ? health : health.online;
}

export async function initialiseSync({ apiUrl, user, deviceInfo, branchId }) {
  const localStatus = await repositories.status.get();
  lastStatus = normalizeLocalStatus(localStatus);
  if (cloudAccessDisabledByOwner()) {
    writeSyncLog("INFO", "sync-paused", { code: "APP_LOCAL_ONLY", apiUrl: normalizeApiUrl(apiUrl) });
    return simulatedOfflineStatus(apiUrl, "initialise");
  }
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
  await checkRailwayServerTime(apiUrl).catch(() => markServerTimeOffline());
  lastStatus = { ...lastStatus, timeDiagnostics: getTimeDiagnostics() };
  logSyncEndpoint("register-device", apiUrl, "/api/sync/register-device", { deviceId: context.deviceId });
  const registrationResponse = await axios.post(endpointUrl(apiUrl, "/api/sync/register-device"), {
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
  const identityResponse = await axios.get(endpointUrl(apiUrl, "/api/device/identity"), {
    ...withTimeout(),
    params: {
      user_id: context.userId,
      device_id: context.deviceId,
      branch_id: context.branchId,
    },
  });
  lastStatus = {
    ...lastStatus,
    canonicalIdentity: identityResponse.data || registrationResponse.data || null,
  };
  return lastStatus;
}

export async function pushPendingOperations({ apiUrl, user, deviceInfo, branchId }) {
  const context = syncContext({ user, deviceInfo, branchId });
  if (cloudAccessDisabledByOwner()) {
    writeSyncLog("INFO", "push-blocked", { code: "APP_LOCAL_ONLY", apiUrl: normalizeApiUrl(apiUrl) });
    return simulatedOfflineStatus(apiUrl, "push");
  }
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const operations = await repositories.outbox.pending(50);
  if (operations.length === 0) {
    writeSyncLog("INFO", "push-skipped", {
      apiUrl: normalizeApiUrl(apiUrl),
      endpoint: endpointUrl(apiUrl, "/api/sync/push"),
      reason: "no-pending-operations",
    });
    return { ...normalizeLocalStatus(await repositories.status.get()), lastPushResult: "NO_PENDING_CHANGES" };
  }
  logSyncEndpoint("push", apiUrl, "/api/sync/push", { count: operations.length });
  lastStatus = {
    ...lastStatus,
    syncStage: "push",
    syncProgressDone: 0,
    syncProgressTotal: operations.length,
  };
  const pushStartedAt = Date.now();
  const response = await axios.post(endpointUrl(apiUrl, "/api/sync/push"), {
    user_id: context.userId,
    device_id: context.deviceId,
    branch_id: context.branchId,
    client_timestamp: authoritativeUtcNowIso(),
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
  observeServerTime({
    serverTime: response.data?.server_time,
    requestStartedAt: pushStartedAt,
    responseReceivedAt: Date.now(),
  });
  writeSyncLog("INFO", "push-result", {
    apiUrl: normalizeApiUrl(apiUrl),
    endpoint: endpointUrl(apiUrl, "/api/sync/push"),
    status: response.status,
    operationCount: operations.length,
    acknowledgementCount: (response.data?.acknowledgements || []).length,
  });
  const status = await repositories.outbox.applyAcks(
    response.data?.acknowledgements || [],
    context.deviceId,
    response.data?.server_time,
  );
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
  if (cloudAccessDisabledByOwner()) {
    writeSyncLog("INFO", "pull-blocked", { code: "APP_LOCAL_ONLY", apiUrl: normalizeApiUrl(apiUrl) });
    return simulatedOfflineStatus(apiUrl, "pull");
  }
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const localStatus = await repositories.status.get();
  const cursor = localStatus.currentCursor || "0";
  logSyncEndpoint("pull", apiUrl, "/api/sync/pull", { cursor });
  const pullStartedAt = Date.now();
  const response = await axios.get(endpointUrl(apiUrl, "/api/sync/pull"), {
    ...withTimeout(15000),
    headers: cursor === "0" && context.deviceSessionToken
      ? { "x-froozerp-device-session": context.deviceSessionToken }
      : undefined,
    params: {
      user_id: context.userId,
      device_id: context.deviceId,
      branch_id: context.branchId,
      cursor,
      limit: 50,
      bootstrap_protocol: cursor === "0" ? "reference-v1" : undefined,
    },
  });
  const pullReceivedAt = Date.now();
  observeServerTime({
    serverTime: response.data?.server_time,
    requestStartedAt: pullStartedAt,
    responseReceivedAt: pullReceivedAt,
  });
  writeSyncLog("INFO", "pull-result", {
    apiUrl: normalizeApiUrl(apiUrl),
    endpoint: endpointUrl(apiUrl, "/api/sync/pull"),
    status: response.status,
    changeCount: (response.data?.changes || []).length,
    bootstrapRecordCount: (response.data?.reference_bootstrap?.records || []).length,
    nextCursor: response.data?.next_cursor || cursor,
    hasMore: Boolean(response.data?.has_more),
  });
  const status = response.data?.reference_bootstrap
    ? await repositories.pull.bootstrap({
        bootstrap: response.data.reference_bootstrap,
        deviceId: context.deviceId,
        serverTime: response.data?.server_time,
      })
    : await applyPulledChanges({
        changes: response.data?.changes || [],
        nextCursor: response.data?.next_cursor || cursor,
        deviceId: context.deviceId,
        serverTime: response.data?.server_time,
      });
  lastStatus = { ...normalizeLocalStatus(status), online: true, lastError: "", apiUrl: normalizeApiUrl(apiUrl), syncStage: "pull" };
  return { ...lastStatus, hasMore: Boolean(response.data?.has_more) };
}

export async function applyPulledChanges({ changes, nextCursor, deviceId, serverTime }) {
  return repositories.pull.apply({ changes, nextCursor, deviceId, serverTime });
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
  if (cloudAccessDisabledByOwner()) {
    writeSyncLog("INFO", "sync-blocked", { code: "APP_LOCAL_ONLY", apiUrl: normalizeApiUrl(apiUrl) });
    return simulatedOfflineStatus(apiUrl, "sync");
  }
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
      const pushStatus = await pushPendingOperations({ apiUrl, user, deviceInfo, branchId });
      let pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
      while (pullStatus.hasMore) {
        pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
      }
      const completed = await repositories.cycle.complete(
        syncContext({ user, deviceInfo, branchId }).deviceId,
        pullStatus.timeDiagnostics?.railwayServerUtcTime || pullStatus.lastPullAt,
        pushStatus.lastPushResult || "ACKNOWLEDGED",
      );
      lastStatus = { ...lastStatus, ...normalizeLocalStatus(completed) };
      resetBackoff();
      lastStatus = { ...lastStatus, syncing: false, online: true, lastError: "", syncStage: "idle", syncProgressDone: 0, syncProgressTotal: 0 };
      return lastStatus;
    } catch (error) {
      clampBackoff();
      const classified = classifySyncError(error, apiUrl);
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

export async function initialPullForApprovedDevice({ apiUrl, user, deviceInfo, branchId }) {
  if (cloudAccessDisabledByOwner()) {
    throw new Error("Initial device provisioning requires FroozERP cloud access.");
  }
  await initialiseSync({ apiUrl, user, deviceInfo, branchId });
  if (!lastStatus.online || !lastStatus.canonicalIdentity) {
    throw new Error(lastStatus.lastError || "The approved cloud device identity could not be confirmed.");
  }
  let pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
  while (pullStatus.hasMore) {
    pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
  }
  const completed = await repositories.cycle.complete(
    syncContext({ user, deviceInfo, branchId }).deviceId,
    pullStatus.timeDiagnostics?.railwayServerUtcTime || pullStatus.lastPullAt,
    "INITIAL_PULL_ACKNOWLEDGED",
  );
  lastStatus = {
    ...lastStatus,
    ...normalizeLocalStatus(completed),
    canonicalIdentity: lastStatus.canonicalIdentity,
    syncing: false,
    online: true,
    lastError: "",
    syncStage: "idle",
  };
  return lastStatus;
}

export function getNextRetryDelay() {
  return backoffMs;
}

export async function queueSafeSyncTest({ value, user, deviceInfo, branchId }) {
  const entityId = `phase2-test-${Date.now()}`;
  await repositories.syncTest.queue({
    entityId,
    value,
    branchId: String(branchId || user?.branch_id || ""),
    deviceId: deviceInfo?.device_id,
    userId: user?.id ? String(user.id) : "",
  });
  return entityId;
}
