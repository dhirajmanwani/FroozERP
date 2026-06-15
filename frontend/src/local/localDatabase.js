const TAURI_GLOBAL_KEYS = ["__TAURI_INTERNALS__", "__TAURI__"];

export const isTauriRuntime = () =>
  typeof window !== "undefined" && TAURI_GLOBAL_KEYS.some((key) => Boolean(window[key]));

const emptyStatus = {
  available: false,
  initialized: false,
  databasePath: "",
  schemaVersion: "",
  pendingOperations: 0,
  failedOperations: 0,
  conflictOperations: 0,
  lastSuccessfulSyncAt: "",
  lastPushAt: "",
  lastPullAt: "",
  currentCursor: "",
  error: "",
};

const invokeLocal = async (command, payload) => {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, payload);
};

const normalizeStatus = (status, fallback = {}) => ({
  ...emptyStatus,
  ...fallback,
  available: true,
  initialized: Boolean(status?.initialized),
  databasePath: status?.database_path || "",
  schemaVersion: status?.schema_version || "",
  pendingOperations: Number(status?.pending_operations || 0),
  failedOperations: Number(status?.failed_operations || 0),
  conflictOperations: Number(status?.conflict_operations || 0),
  lastSuccessfulSyncAt: status?.last_successful_sync_at || "",
  lastPushAt: status?.last_push_at || "",
  lastPullAt: status?.last_pull_at || "",
  currentCursor: status?.current_cursor || "",
  error: status?.error || "",
});

export async function initializeLocalDatabase() {
  if (!isTauriRuntime()) return emptyStatus;
  try {
    const status = await invokeLocal("local_db_initialize");
    return normalizeStatus(status);
  } catch (error) {
    return normalizeStatus(null, {
      initialized: false,
      error: error?.message || String(error || "Unable to initialize local database"),
    });
  }
}

export async function getLocalDatabaseStatus() {
  if (!isTauriRuntime()) return emptyStatus;
  try {
    const status = await invokeLocal("local_db_status");
    return normalizeStatus(status);
  } catch (error) {
    return normalizeStatus(null, {
      initialized: false,
      error: error?.message || String(error || "Unable to read local database status"),
    });
  }
}

export async function setLocalSmokeValue(value) {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_db_set_smoke_value", { value });
}

export async function getLocalSmokeValue() {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_db_get_smoke_value");
}

export async function enqueueSyncOperation(operation) {
  if (!isTauriRuntime()) {
    throw new Error("Local sync outbox is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("sync_outbox_enqueue", { operation });
}

export async function getPendingOutboxCount() {
  if (!isTauriRuntime()) return 0;
  return invokeLocal("sync_outbox_count");
}

export async function getPendingOutbox(limit = 50) {
  if (!isTauriRuntime()) return [];
  return invokeLocal("sync_outbox_pending", { limit });
}

export async function applyPushAcknowledgements(acks) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_apply_push_acks", { acks });
  return normalizeStatus(status);
}

export async function applyPulledChanges({ changes, nextCursor, deviceId }) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_apply_pull_changes", {
    changes,
    nextCursor,
    deviceId,
  });
  return normalizeStatus(status);
}

export async function markSyncFailed(message) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_mark_failed", { message });
  return normalizeStatus(status);
}

export async function retryFailedLocalOperations() {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_retry_failed_operations");
  return normalizeStatus(status);
}

export async function queueSyncTestEntity({ entityId, value, branchId, deviceId, userId }) {
  if (!isTauriRuntime()) {
    throw new Error("Local sync test writes are only available inside the FroozERP desktop app.");
  }
  return invokeLocal("sync_queue_test_entity", {
    entityId,
    value,
    branchId,
    deviceId,
    userId,
  });
}

export async function completeLocalPosSale(sale) {
  if (!isTauriRuntime()) {
    throw new Error("Local-first POS checkout is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("pos_sale_complete_local", { sale });
}
