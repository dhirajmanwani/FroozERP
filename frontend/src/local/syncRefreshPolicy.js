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
 * 3. A bill made on a counter waited for that counter's next background cycle (up to a minute) before
 *    the cloud heard of it, and another computer pulls on its own minute after that, so the other
 *    computer's stock lagged by up to two minutes (owner, 8 Nov 2026: "proper clouding"). A desktop
 *    bill saved to this computer's SQLite now starts a sync straight away, not awaited.
 *
 * LOCAL_ONLY is untouched by all three: `runSyncNow` refuses there before any request, and `syncNow`
 * returns `pullCompleted: false` for it.
 */

export const shouldRefreshAfterSync = (status) => Boolean(status) && (status.pullCompleted === true || !status.lastError);

/**
 * Whether a purchase save should start an immediate sync: on the desktop, and only for a save that
 * went to the server (a queued offline save is already in SQLite, and syncs on its own cycle).
 */
export const shouldSyncAfterPurchaseSave = ({ tauriRuntime = false, queuedOffline = false } = {}) => Boolean(tauriRuntime) && !queuedOffline;

/**
 * Whether a POS bill should start an immediate sync: on the desktop, and only for a bill saved to
 * this computer's SQLite (`localSale`). A bill the browser POS wrote straight to the cloud is
 * already there.
 */
export const shouldSyncAfterLocalSale = ({ tauriRuntime = false, localSale = null } = {}) => Boolean(tauriRuntime) && Boolean(localSale);
