import { enqueueSyncOperation } from "./localDatabase";

const newId = () =>
  typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `local-${Date.now()}-${Math.random().toString(16).slice(2)}`;

const nowIso = () => new Date().toISOString();

export class SyncOutboxRepository {
  async enqueue({ entityType, entityId, operationType, payload, branchId, deviceId, version = 1 }) {
    const operation = {
      id: newId(),
      entity_type: entityType,
      entity_id: entityId,
      operation_type: operationType,
      payload,
      branch_id: branchId || "",
      device_id: deviceId || "",
      version,
      created_at: nowIso(),
    };
    return enqueueSyncOperation(operation);
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
  outbox: new SyncOutboxRepository(),
};
