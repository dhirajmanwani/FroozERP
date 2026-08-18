/**
 * Whether an offline device may open its modules — and what to say when it has no data yet.
 *
 * ## The defect this exists to fix
 *
 * `reference_ready` (`local_db.rs`) is computed as `!products.is_empty() && !inventory_lots.is_empty()`.
 * It answers **"does this device hold business data?"**, but `App.jsx` used it to answer
 * **"is this device authorised to work offline?"** — blocking both offline login and module
 * navigation with "This device must connect to the internet once before offline use."
 *
 * Those two questions coincided for as long as the only route to a working device was a cloud
 * sync: no sync meant no authorisation *and* no data. Offline activation
 * (`docs/offline-activation-design.md`) splits them apart. A device activated from a signed `.lic`
 * is fully authorised and has legitimately never synced, so it holds zero products until its owner
 * enters the first one — and the old gate told that owner to do the one thing the whole feature
 * exists to make unnecessary. It also locked the device out of *login* on the next restart, which
 * is the precise failure mode §11.2 was written to end.
 *
 * So: **entitlement decides access; data presence decides what the user is shown.**
 *
 * ## Empty is not always innocent
 *
 * A device that has never synced and holds nothing is a new shop. A device that *has* synced
 * before and now holds nothing is a device whose data went missing, or whose sync died partway —
 * and rendering that as a quiet ₹0.00 is exactly the failure `CLAUDE.md` names: "Errors must never
 * render as zero. A failed load, a contract violation or an internal inconsistency has to produce a
 * distinct error state." `last_successful_sync_at` is what separates the two, so the two get
 * separate codes and separate copy. Neither one blocks — a shop is never locked out over this —
 * but the suspicious one says so out loud.
 *
 * ## Why access keys off billing capability
 *
 * `billingAllowed` is the §2.2 invariant: every state except `Unprovisioned` may bill. A device
 * that may bill must be able to reach the screens it bills from, so access is derived from that
 * single predicate rather than re-listing states here. If the two ever diverge, the entitlement
 * state table is the one place to change.
 *
 * When the entitlement state is unknown (`null`) — a status read that failed, or a non-desktop
 * runtime — this falls back to the legacy `reference_ready` behaviour rather than assuming either
 * way. Failing into the previous behaviour is the conservative reading of design §2.5.
 */

import { billingAllowed } from "./entitlementState.js";

export const OFFLINE_OPEN_CODES = {
  /** Provisioned (or legacy-with-data) and holding business data. Nothing to say. */
  READY: "READY",
  /** Entitled, empty, and never synced — a new device whose owner has not entered data yet. */
  EMPTY_NEW_DEVICE: "EMPTY_NEW_DEVICE",
  /** Entitled, empty, but it has synced before. Empty here is a symptom, not a starting point. */
  EMPTY_AFTER_SYNC: "EMPTY_AFTER_SYNC",
  /** No entitlement and no data: genuinely not set up for offline use. The only blocking code. */
  NOT_PROVISIONED: "NOT_PROVISIONED",
};

const MESSAGES = {
  [OFFLINE_OPEN_CODES.READY]: "",
  [OFFLINE_OPEN_CODES.EMPTY_NEW_DEVICE]:
    "No products or stock are on this device yet. Add your first product from the Products module to start billing.",
  [OFFLINE_OPEN_CODES.EMPTY_AFTER_SYNC]:
    "This device has synced before, but no products or stock are loaded. Business data may be incomplete — check the sync status before billing.",
  // The old wording told the user to connect to the internet, which is unsatisfiable when the
  // cloud is gone (backlog item 5). Now that on-device activation exists, this names the route
  // that actually works.
  [OFFLINE_OPEN_CODES.NOT_PROVISIONED]:
    "This device is not activated for offline use. Import an activation file (.lic) from the FroozERP owner, or connect once to the cloud to provision it.",
};

const hasText = (value) => typeof value === "string" && value.trim().length > 0;

/**
 * Has this device ever completed a sync? Read from the snapshot, and deliberately tolerant: the
 * field is absent on some snapshot shapes and an empty string on others, and neither means "synced".
 */
export const hasSyncedBefore = (snapshot) => hasText(snapshot?.last_successful_sync_at);

/**
 * @param {object} input
 * @param {object|null} input.snapshot  the reference snapshot from SQLite.
 * @param {string|null} input.entitlementState  e.g. "Active"; `null` when unknown.
 * @returns {{allowed: boolean, code: string, message: string, empty: boolean, suspicious: boolean}}
 *   `allowed` gates login and navigation. `empty` means "open, but there is nothing to show yet".
 *   `suspicious` marks the empty-after-sync case so callers can present it as a warning rather
 *   than as an ordinary empty state.
 */
export const resolveOfflineOpenDecision = ({ snapshot = null, entitlementState = null } = {}) => {
  const referenceReady = Boolean(snapshot?.reference_ready);
  const entitled = entitlementState === null || entitlementState === undefined
    ? null
    : billingAllowed(entitlementState);

  // Data present: always allowed, whatever the entitlement says. A device holding real business
  // data must never be shut out of it — that would be the lockout this module exists to remove,
  // wearing a different hat.
  if (referenceReady) {
    return {
      allowed: true,
      code: OFFLINE_OPEN_CODES.READY,
      message: MESSAGES[OFFLINE_OPEN_CODES.READY],
      empty: false,
      suspicious: false,
    };
  }

  // Empty, and either unentitled or unknown: preserve the pre-existing gate.
  if (entitled !== true) {
    return {
      allowed: false,
      code: OFFLINE_OPEN_CODES.NOT_PROVISIONED,
      message: MESSAGES[OFFLINE_OPEN_CODES.NOT_PROVISIONED],
      empty: true,
      suspicious: false,
    };
  }

  // Empty but entitled. Open either way; the codes differ only in what the user is told.
  const suspicious = hasSyncedBefore(snapshot);
  const code = suspicious
    ? OFFLINE_OPEN_CODES.EMPTY_AFTER_SYNC
    : OFFLINE_OPEN_CODES.EMPTY_NEW_DEVICE;
  return {
    allowed: true,
    code,
    message: MESSAGES[code],
    empty: true,
    suspicious,
  };
};
