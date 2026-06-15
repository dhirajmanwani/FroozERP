import {
  applyPulledChanges,
  applyPushAcknowledgements,
  enqueueSyncOperation,
  getPendingOutbox,
  getLocalDatabaseStatus,
  markSyncFailed,
  queueSyncTestEntity,
  retryFailedLocalOperations,
} from "./localDatabase";

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const nowIso = () => new Date().toISOString();

export class SyncOutboxRepository {
  async enqueue({ entityType, entityId, operationType, payload, branchId, deviceId, userId, version = 1 }) {
    const operation = {
      id: newId(),
      operation_id: newId(),
      entity_type: entityType,
      entity_id: entityId,
      operation_type: operationType,
      payload,
      branch_id: branchId || "",
      device_id: deviceId || "",
      user_id: userId ? String(userId) : "",
      version,
      created_at: nowIso(),
    };
    return enqueueSyncOperation(operation);
  }

  async pending(limit = 50) {
    return getPendingOutbox(limit);
  }

  async applyAcks(acks) {
    return applyPushAcknowledgements(acks);
  }

  async retryFailed() {
    return retryFailedLocalOperations();
  }
}

export class LocalCacheRepository {
  constructor(entityType) {
    this.entityType = entityType;
  }

  async queueUpsert(entityId, payload, context = {}) {
    return new SyncOutboxRepository().enqueue({
      entityType: this.entityType,
      entityId,
      operationType: "UPSERT",
      payload,
      ...context,
    });
  }
}

export const repositories = {
  products: new LocalCacheRepository("product"),
  categories: new LocalCacheRepository("category"),
  lots: new LocalCacheRepository("inventory_lot"),
  settings: new LocalCacheRepository("setting"),
  syncTest: {
    queue: queueSyncTestEntity,
  },
  pull: {
    apply: applyPulledChanges,
  },
  status: {
    get: getLocalDatabaseStatus,
    fail: markSyncFailed,
  },
  outbox: new SyncOutboxRepository(),
};
