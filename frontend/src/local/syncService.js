import axios from "axios";
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

const syncContext = ({ user, deviceInfo, branchId }) => ({
  userId: user?.id,
  deviceId: deviceInfo?.device_id,
  deviceName: deviceInfo?.device_name,
  branchId: String(branchId || user?.branch_id || 1),
});

export async function checkBackendHealth(apiUrl) {
  try {
    const response = await axios.get(`${apiUrl}/api/health`, withTimeout(5000));
    return response.data?.status === "ok";
  } catch {
    return false;
  }
}

export async function initialiseSync({ apiUrl, user, deviceInfo, branchId }) {
  const localStatus = await repositories.status.get();
  lastStatus = normalizeLocalStatus(localStatus);
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const online = await checkBackendHealth(apiUrl);
  lastStatus = { ...lastStatus, online };
  if (!online) return lastStatus;
  await axios.post(`${apiUrl}/api/sync/register-device`, {
    device_id: context.deviceId,
    device_name: context.deviceName || "FroozERP Device",
    platform: "tauri-windows",
    app_version: "1.0.0",
    branch_id: context.branchId,
  }, withTimeout());
  return lastStatus;
}

export async function pushPendingOperations({ apiUrl, user, deviceInfo, branchId }) {
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const operations = await repositories.outbox.pending(50);
  if (operations.length === 0) return normalizeLocalStatus(await repositories.status.get());
  const response = await axios.post(`${apiUrl}/api/sync/push`, {
    user_id: context.userId,
    device_id: context.deviceId,
    branch_id: context.branchId,
    client_timestamp: new Date().toISOString(),
    operations: operations.map((operation) => ({
      operation_id: operation.operation_id,
      entity_type: operation.entity_type,
      entity_id: operation.entity_id,
      operation_type: operation.operation_type,
      version: operation.version,
      payload: operation.payload,
      created_at: operation.created_at,
    })),
  }, withTimeout(15000));
  const status = await repositories.outbox.applyAcks(response.data?.acknowledgements || []);
  lastStatus = { ...normalizeLocalStatus(status), online: true, lastError: "" };
  return lastStatus;
}

export async function pullServerChanges({ apiUrl, user, deviceInfo, branchId }) {
  const context = syncContext({ user, deviceInfo, branchId });
  if (!isTauriRuntime() || !context.userId || !context.deviceId) return lastStatus;
  const localStatus = await repositories.status.get();
  const cursor = localStatus.currentCursor || "0";
  const response = await axios.get(`${apiUrl}/api/sync/pull`, {
    ...withTimeout(15000),
    params: {
      user_id: context.userId,
      device_id: context.deviceId,
      branch_id: context.branchId,
      cursor,
      limit: 50,
    },
  });
  const status = await applyPulledChanges({
    changes: response.data?.changes || [],
    nextCursor: response.data?.next_cursor || cursor,
    deviceId: context.deviceId,
  });
  lastStatus = { ...normalizeLocalStatus(status), online: true, lastError: "" };
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
    lastStatus = { ...lastStatus, syncing: true, lastError: "" };
    try {
      await initialiseSync({ apiUrl, user, deviceInfo, branchId });
      if (!lastStatus.online) throw new Error("FroozERP backend is offline");
      await pushPendingOperations({ apiUrl, user, deviceInfo, branchId });
      let pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
      while (pullStatus.hasMore) {
        pullStatus = await pullServerChanges({ apiUrl, user, deviceInfo, branchId });
      }
      resetBackoff();
      lastStatus = { ...lastStatus, syncing: false, online: true, lastError: "" };
      return lastStatus;
    } catch (error) {
      clampBackoff();
      const message = error.response?.data?.message || error.message || "Sync failed";
      const status = await repositories.status.fail(message);
      lastStatus = { ...normalizeLocalStatus(status), syncing: false, online: false, lastError: message };
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
