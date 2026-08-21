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
  lastPushResult: "",
  currentCursor: "",
  error: "",
};

const invokeLocal = async (command, payload) => {
  if (!isTauriRuntime()) return null;
  const { invoke } = await import("@tauri-apps/api/core");
  return invoke(command, payload);
};

export const sanitizeLocalSnapshotLoadError = (error) => {
  const rawMessage = String(error?.message || error || "");
  let code = "LOCAL_SNAPSHOT_LOAD_FAILED";
  let message = "Saved offline data could not be loaded. Retry local service readiness.";

  if (/missing required key\s+deviceId|invalid args.*local_load_reference_snapshot/i.test(rawMessage)) {
    code = "LOCAL_SNAPSHOT_BRIDGE_CONTRACT";
    message = "Saved offline data could not be loaded because the desktop runtime is incompatible with this application build.";
  } else if (/database disk image is malformed|file is not a database|database corruption/i.test(rawMessage)) {
    code = "LOCAL_SNAPSHOT_CORRUPT";
    message = "Saved offline data is damaged. FroozERP preserved it and did not create a replacement database.";
  } else if (/no such table|no such column|unsupported schema|incompatible schema|schema.*incompatible/i.test(rawMessage)) {
    code = "LOCAL_SNAPSHOT_INCOMPATIBLE";
    message = "Saved offline data uses an incompatible schema. FroozERP preserved it and did not create a replacement database.";
  }

  const diagnostic = new Error(`${message} (${code})`);
  diagnostic.code = code;
  return diagnostic;
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
  lastPushResult: status?.last_push_result || "",
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

export async function cacheLocalReferenceSnapshot(snapshot) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("local_cache_reference_snapshot", { snapshot });
  return normalizeStatus(status);
}

export async function loadLocalReferenceSnapshot({ username, deviceId } = {}) {
  if (!isTauriRuntime()) return null;
  try {
    return await invokeLocal("local_load_reference_snapshot", {
      username: username || null,
      deviceId: deviceId || null,
    });
  } catch (error) {
    throw sanitizeLocalSnapshotLoadError(error);
  }
}

export async function getOrCreateLocalDeviceIdentity(preferredDeviceId = "") {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_get_or_create_device_identity", {
    preferredDeviceId: String(preferredDeviceId || "").trim() || null,
  });
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

export async function markOutboxOperationsSyncing(operationIds) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_outbox_mark_syncing", { operationIds });
  return normalizeStatus(status);
}

export async function releaseOutboxOperations(operationIds, message = "") {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_outbox_release_syncing", { operationIds, message: message || null });
  return normalizeStatus(status);
}

export async function applyPushAcknowledgements(acks, deviceId, serverTime) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_apply_push_acks", { acks, deviceId, serverTime });
  return normalizeStatus(status);
}

export async function auditLocalDatabase() {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_db_audit");
}

export async function recordConnectivityModeChange({ userId, username, role, deviceId, previousMode, nextMode, serverConfirmedAt, timeSource }) {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_record_connectivity_mode_change", {
    user_id: String(userId || ""),
    username: username || null,
    role: String(role || ""),
    device_id: String(deviceId || ""),
    previous_mode: String(previousMode || ""),
    next_mode: String(nextMode || ""),
    server_confirmed_at: String(serverConfirmedAt || ""),
    time_source: String(timeSource || "device"),
  });
}

export async function recordSyncCycleCompleted(deviceId, serverTime, pushResult) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_record_cycle_completed", { deviceId, serverTime, pushResult });
  return normalizeStatus(status);
}

export async function applyPulledChanges({ changes, nextCursor, deviceId, serverTime }) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_apply_pull_changes", {
    changes,
    nextCursor,
    deviceId,
    serverTime,
  });
  return normalizeStatus(status);
}

export async function applyReferenceBootstrap({ bootstrap, deviceId, serverTime }) {
  if (!isTauriRuntime()) return emptyStatus;
  const status = await invokeLocal("sync_apply_reference_bootstrap", {
    bootstrap,
    deviceId,
    serverTime,
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

export async function editLocalPosSale(edit) {
  if (!isTauriRuntime()) {
    throw new Error("Local-first POS editing is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("pos_sale_edit_local", { edit });
}

export async function cancelLocalPosSale(cancellation) {
  if (!isTauriRuntime()) {
    throw new Error("Local-first POS cancellation is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("pos_sale_cancel_local", { cancellation });
}

export async function loadLocalPosSale(invoiceId) {
  if (!isTauriRuntime()) {
    throw new Error("Local-first POS invoice loading is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("pos_sale_load_local", { invoiceId: String(invoiceId || "") });
}

export async function listLocalPosSales() {
  if (!isTauriRuntime()) return [];
  return invokeLocal("pos_sale_list_local");
}

export async function queueLocalPurchase(purchase) {
  if (!isTauriRuntime()) {
    throw new Error("Offline purchase entry is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("purchase_queue_local", { purchase });
}

export async function listLocalPurchases() {
  if (!isTauriRuntime()) return [];
  return invokeLocal("purchase_list_local");
}

// ---------------------------------------------------------------------------
// Offline activation entitlements (docs/offline-activation-plan.md Stage 5).
// The frontend never evaluates entitlement policy itself (design §2.3) — it
// asks the Rust shell for the state and renders it.
// ---------------------------------------------------------------------------

/**
 * Current entitlement state for a device. Off-desktop this returns Unprovisioned
 * so browser/dev builds never mistake "no shell" for "no licence".
 */
export async function getEntitlementStatus(deviceId) {
  if (!isTauriRuntime()) {
    return { state: "Unprovisioned", billing_allowed: false, capabilities: null };
  }
  return invokeLocal("entitlement_status", { deviceId: String(deviceId || "") });
}

/** Redeem raw signed activation bytes (base64 payload + signature). */
export async function redeemEntitlement({ deviceId, payloadBase64, signatureBase64, source } = {}) {
  if (!isTauriRuntime()) {
    throw new Error("Activation is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("entitlement_redeem", {
    deviceId: String(deviceId || ""),
    payloadBase64: String(payloadBase64 || ""),
    signatureBase64: String(signatureBase64 || ""),
    source: source || null,
  });
}

/** Import a .lic activation file (whole file text) and redeem it. */
export async function importEntitlementFile({ deviceId, contents, source } = {}) {
  if (!isTauriRuntime()) {
    throw new Error("Activation is only available inside the FroozERP desktop app.");
  }
  return invokeLocal("entitlement_import_file", {
    deviceId: String(deviceId || ""),
    contents: String(contents || ""),
    source: source || null,
  });
}

/**
 * Mark the bootstrap Owner credential consumed after the forced password change
 * completes (design §8.2). Single-use is local policy — never reversible.
 */
export async function consumeBootstrapCredential({ deviceId, entitlementSerial } = {}) {
  if (!isTauriRuntime()) return null;
  return invokeLocal("entitlement_consume_bootstrap", {
    deviceId: String(deviceId || ""),
    entitlementSerial: String(entitlementSerial || ""),
  });
}

/**
 * Customer orders, held on this device.
 *
 * G7's order half works with no cloud and no website, so these go straight to SQLite rather than
 * through the backend. Each returns `null` outside the desktop shell — the browser dev server has
 * no local database, and a caller that treats null as "no orders" would be wrong in a way that only
 * shows up as an empty board.
 */
export async function saveLocalCustomerOrder(order) {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_save_customer_order", { order });
}

export async function listLocalCustomerOrders() {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_list_customer_orders");
}

export async function setLocalCustomerOrderStatus({ orderId, nextStatus, patch = {} }) {
  if (!isTauriRuntime()) return null;
  return invokeLocal("local_set_customer_order_status", {
    orderId: String(orderId || ""),
    nextStatus: String(nextStatus || ""),
    patch,
  });
}
