/**
 * What this machine is in the middle of, in words a person would use.
 *
 * An update that installs itself has to restart the app, and a restart in the wrong second costs
 * somebody a half-made bill with a customer standing at the counter. So before anything restarts
 * itself it asks this: is there work here that a restart would destroy or interrupt?
 *
 * The answers are returned as `{ id, label }` rather than a boolean because the screen has to be
 * able to say *what* it is waiting for. "The update will install once this is finished: a bill in
 * progress" is a sentence somebody can act on. A spinner is not.
 *
 * A fact that is missing reads as "not busy", which is the one dangerous thing in here and is
 * deliberate: the alternative, treating absent as busy, means a device that is never wired up
 * correctly simply never updates, and a feature that silently does nothing is harder to notice
 * than one that acts. The safety therefore lives in the wiring rather than in this default, and
 * the wiring is pinned by a test that reads App.jsx and fails if the shell stops passing any of
 * these facts. If you add a fact here, add it to that test in the same change.
 *
 * It knows nothing about React. Everything it needs is handed in as plain values, which is why the
 * rules can be tested at all -- the two facts that matter most, an in-progress POS bill and a save
 * in flight, live inside a component and have to be passed up to reach here.
 */

const WORK = Object.freeze({
  POS_CART: { id: "pos-cart", label: "a bill in progress" },
  POS_SAVING: { id: "pos-saving", label: "a bill being saved" },
  PURCHASE_CART: { id: "purchase-cart", label: "a purchase bill in progress" },
  PURCHASE_SAVING: { id: "purchase-saving", label: "a purchase being saved" },
  ORDER_HANDOFF: { id: "order-handoff", label: "an order waiting to be billed" },
  OPEN_FORM: { id: "open-form", label: "an open form with unsaved changes" },
  PRINTING: { id: "printing", label: "a bill being printed" },
  PENDING_SYNC: { id: "pending-sync", label: "sales still waiting to be sent" },
  BACKUP: { id: "backup", label: "a backup being taken" },
  BUSY_OPERATION: { id: "busy-operation", label: "an operation still running" },
  STARTING_UP: { id: "starting-up", label: "the app still starting up" },
});

const isTruthyCount = (value) => {
  if (Array.isArray(value)) return value.length > 0;
  const count = Number(value);
  return Number.isFinite(count) && count > 0;
};

/**
 * @param {object} facts every one optional; anything missing is read as "not busy" unless it is
 *   named below as a fact whose absence means "not known yet".
 * @returns {Array<{id: string, label: string}>} empty when this machine is free
 */
export const collectWorkInProgress = (facts = {}) => {
  const source = facts && typeof facts === "object" ? facts : {};
  const reasons = [];
  const add = (entry) => {
    if (!reasons.some((existing) => existing.id === entry.id)) reasons.push({ ...entry });
  };

  if (isTruthyCount(source.posCartLines)) add(WORK.POS_CART);
  if (source.posSaving === true) add(WORK.POS_SAVING);
  if (isTruthyCount(source.purchaseCartLines)) add(WORK.PURCHASE_CART);
  if (source.purchaseSaving === true) add(WORK.PURCHASE_SAVING);
  if (source.pendingOrderBill) add(WORK.ORDER_HANDOFF);

  // Any one of these open means somebody has typed something that is not saved yet. They are one
  // reason rather than six because the person reading the sentence does not need the inventory.
  if (source.editingSale || source.cancelDraft || source.lotAction
    || source.editingProductId || source.editingPurchaseId || source.addingOpeningStock) {
    add(WORK.OPEN_FORM);
  }

  if (source.printingInvoice) add(WORK.PRINTING);

  // The manual install path already refuses while the outbox is not empty, and it is right to:
  // these are completed sales that exist only on this machine until they are sent.
  if (isTruthyCount(source.pendingSyncOperations)) add(WORK.PENDING_SYNC);
  if (source.backupRunning === true) add(WORK.BACKUP);

  if (source.shopSwitching === true || source.distributionBusy === true
    || source.orderActionBusy === true || source.orderRoutingBusy === true
    || source.connectivitySwitching === true) {
    add(WORK.BUSY_OPERATION);
  }

  // Not work somebody is doing, but a machine that has not finished starting has a backend still
  // settling underneath it, and restarting into that is how a half-applied update happens.
  if (source.startupSettled === false) add(WORK.STARTING_UP);

  return reasons;
};

/** The vocabulary, exported so a caller can name a reason without copying the string. */
export const WORK_IN_PROGRESS_KINDS = WORK;
