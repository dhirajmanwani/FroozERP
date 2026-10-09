/**
 * When a sync cycle should refresh the screens, and when a save should start one.
 *
 * On a live counter the Owner saved a Stock Arrival and POS never showed it. Two causes:
 *
 * 1. The screens were refreshed after a sync only when the cycle had no error at all. A cycle whose
 *    *push* failed (one stuck local change) had still *pulled* the new lots into SQLite, and nothing
 *    redrew from them. `syncNow()` now reports `pullCompleted`; a completed pull is reason enough.
 * 2. An online purchase is written to the cloud, and the desktop's POS reads SQLite, which only
 *    learns of it at the next background cycle — up to a minute later. A desktop save now starts a
 *    sync straight away.
 *
 * LOCAL_ONLY is untouched by both: `runSyncNow` refuses there before any request, and `syncNow`
 * returns `pullCompleted: false` for it.
 */

export const shouldRefreshAfterSync = (status) => Boolean(status) && (status.pullCompleted === true || !status.lastError);

/**
 * Whether a purchase save should start an immediate sync: on the desktop, and only for a save that
 * went to the server (a queued offline save is already in SQLite, and syncs on its own cycle).
 */
export const shouldSyncAfterPurchaseSave = ({ tauriRuntime = false, queuedOffline = false } = {}) => Boolean(tauriRuntime) && !queuedOffline;
