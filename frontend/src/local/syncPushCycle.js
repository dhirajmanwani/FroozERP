/**
 * The decisions inside one push/pull cycle, kept free of axios, Tauri and Vite so `node:test` can
 * hold them. `syncService.js` supplies the I/O; this module decides what to send, which outbox rows
 * are settled, which go back to pending, and whether a failed push still lets the pull run.
 *
 * ## What went wrong before
 *
 * 1. Sale acknowledgements from `/api/sync/push` were held until every offline purchase had been
 *    replayed. One purchase replay failing for a non-business reason (401/403/5xx/network) threw,
 *    and the catch released *every* operation id -- including sales the server had just accepted.
 *    They were re-sent forever and never marked synced. Acks are now applied as soon as the push
 *    answers, and a throw releases only what is still unsettled.
 * 2. A replayed purchase spread its queued payload into the body, and that payload carries the
 *    identity of whoever queued it. `rejectDeviceSessionSubstitution` compares those fields with the
 *    signed session, so a purchase queued by one user and replayed under another was refused with a
 *    403 -- for ever, since it is a non-business failure and is retried. The server scopes the write
 *    from the session anyway; the identity fields are stripped and the author kept as
 *    `queued_by_user_id`, which nothing on the server treats as an identity claim.
 * 3. A push that failed stopped the cycle before the pull, so one stuck purchase meant no stock
 *    arrival, price or product change ever reached the device.
 */

/** Body fields `rejectDeviceSessionSubstitution` reads as a claim about the caller. */
export const REPLAY_IDENTITY_FIELDS = Object.freeze(["user_id", "device_id", "company_id", "branch_id"]);

const operationKey = (value) => String(value ?? "").trim();

/**
 * The body for replaying one queued purchase: its payload without the identity it was queued
 * under. `req.auth` is the only identity the server accepts; the queuing author rides along as data.
 */
export const purchaseReplayBody = (operation) => {
  const payload = operation?.payload && typeof operation.payload === "object" ? operation.payload : {};
  const body = { ...payload };
  for (const field of REPLAY_IDENTITY_FIELDS) delete body[field];
  const author = operationKey(payload.user_id ?? operation?.user_id);
  if (author && body.queued_by_user_id == null) body.queued_by_user_id = author;
  body.idempotency_key = operation.operation_id;
  body.operation_id = operation.operation_id;
  return body;
};

export const isPurchaseReplay = (operation) => operation?.entity_type === "purchase_grn";

/**
 * Push one batch of outbox operations.
 *
 * @param {object} io
 * @param {Array<object>} io.operations already marked syncing by the caller
 * @param {(ops: Array<object>) => Promise<{acknowledgements?: Array<object>, serverTime?: string}>} io.pushRegular
 * @param {(op: object) => Promise<{acknowledgement: object, serverTime?: string}>} io.replayPurchase
 *   resolves with a verdict on the purchase, or throws when nothing judged it
 * @param {(acks: Array<object>, serverTime: string) => Promise<object>} io.applyAcks
 * @param {(ids: Array<string>, message: string) => Promise<unknown>} io.release
 * @param {() => string} io.now fallback server time
 * @returns {Promise<{status: object|null, serverTime: string, acknowledgementCount: number,
 *   unacknowledged: Array<string>}>}
 */
export async function runPushCycle({ operations = [], pushRegular, replayPurchase, applyAcks, release, now }) {
  const unsettled = new Set(operations.map((operation) => operationKey(operation.operation_id)));
  let status = null;
  let serverTime = "";
  let acknowledgementCount = 0;
  const unacknowledged = [];

  const settle = async (acks) => {
    if (acks.length === 0) return;
    status = await applyAcks(acks, serverTime || now());
    for (const ack of acks) unsettled.delete(operationKey(ack?.operation_id));
    acknowledgementCount += acks.length;
  };
  const releaseUnsettled = async (message) => {
    if (unsettled.size === 0) return;
    const ids = operations.map((op) => op.operation_id).filter((id) => unsettled.has(operationKey(id)));
    await release(ids, message);
    for (const id of ids) unsettled.delete(operationKey(id));
  };

  try {
    const regular = operations.filter((operation) => !isPurchaseReplay(operation));
    if (regular.length > 0) {
      const response = (await pushRegular(regular)) || {};
      serverTime = response.serverTime || serverTime;
      const sent = new Set(regular.map((operation) => operationKey(operation.operation_id)));
      // Only acks for what was sent; anything else is not ours to settle.
      const acks = (Array.isArray(response.acknowledgements) ? response.acknowledgements : [])
        .filter((ack) => sent.has(operationKey(ack?.operation_id)));
      await settle(acks);
      // A 200 that did not answer for an operation leaves it in `syncing` for good unless released.
      const answered = new Set(acks.map((ack) => operationKey(ack.operation_id)));
      const missing = regular.filter((operation) => !answered.has(operationKey(operation.operation_id)));
      if (missing.length > 0) {
        const ids = missing.map((operation) => operation.operation_id);
        unacknowledged.push(...ids);
        await release(ids, "The server did not acknowledge this change; it will be sent again.");
        for (const id of ids) unsettled.delete(operationKey(id));
      }
    }

    for (const operation of operations.filter(isPurchaseReplay)) {
      // Settled one at a time, so a later replay that throws cannot undo an accepted earlier one.
      const result = await replayPurchase(operation);
      serverTime = result.serverTime || serverTime;
      await settle([result.acknowledgement]);
    }
  } catch (error) {
    await releaseUnsettled(error?.message || "Network interruption; purchase remains queued");
    throw error;
  }
  return { status, serverTime, acknowledgementCount, unacknowledged };
}

/**
 * Push, then pull -- and still pull when the push failed for a reason other than being offline.
 *
 * A push failure is about *this device's* queue; the pull is how stock arrivals and price changes
 * reach the counter. Coupling them meant one stuck purchase replay froze POS stock. When the push
 * failed because the cloud is unreachable the pull would fail too, so that case still stops early.
 *
 * @returns {Promise<{pushStatus: object|null, pushError: Error|null, pullStatus: object, pullCompleted: true}>}
 *   Throws when the pull fails (the push error first, if there was one, with the pull's attached as
 *   `pullError`), or when the push failed in a way that means the pull should not be attempted.
 *   Resolving with a `pushError` means the pull finished but the push did not: the caller must still
 *   report that error.
 */
export async function runPushThenPull({ push, pullOnce, pullAfterPushFailure }) {
  let pushStatus = null;
  let pushError = null;
  try {
    pushStatus = await push();
  } catch (error) {
    if (!pullAfterPushFailure(error)) throw error;
    pushError = error;
  }
  try {
    let pullStatus = await pullOnce();
    while (pullStatus?.hasMore) pullStatus = await pullOnce();
    return { pushStatus, pushError, pullStatus, pullCompleted: true };
  } catch (pullError) {
    // The push failure came first and is what the owner needs to see; the pull's is kept beside it.
    if (pushError) {
      pushError.pullError = pullError;
      throw pushError;
    }
    throw pullError;
  }
}
