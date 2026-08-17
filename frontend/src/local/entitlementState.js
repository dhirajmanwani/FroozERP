// Pure JavaScript mirror of the offline-activation entitlement state machine.
//
// This is the frontend counterpart of `src-tauri/src/entitlement.rs`. Per the design
// (docs/offline-activation-design.md §2.2, §9) the frontend NEVER decides policy — Rust does.
// This module only mirrors the state table so the shell can render the correct banner and hide
// capabilities the reported state does not carry. Keep it byte-for-byte faithful to entitlement.rs:
//   - capabilitiesForState mirrors EntitlementState::capabilities()
//   - billingAllowed mirrors EntitlementState::billing_allowed() (the §2.2 invariant)
//   - holdsPreviousState mirrors EntitlementState::holds_previous_state()
//
// No I/O, no network, no imports from App.jsx.

export const ENTITLEMENT_STATES = Object.freeze({
  UNPROVISIONED: "Unprovisioned",
  ACTIVE: "Active",
  GRACE: "Grace",
  EXPIRED: "Expired",
  REVOKED: "Revoked",
  CLOCK_ANOMALY: "ClockAnomaly",
  MALFORMED: "Malformed",
});

const caps = (billing, local_reports, sync, admin, provisioning) =>
  Object.freeze({ billing, local_reports, sync, admin, provisioning });

/**
 * Capabilities for a determinate state, or `null` for the "hold previous state" states
 * (ClockAnomaly, Malformed). Mirrors EntitlementState::capabilities() in entitlement.rs exactly.
 */
export const capabilitiesForState = (state) => {
  switch (state) {
    case ENTITLEMENT_STATES.UNPROVISIONED:
      return caps(false, false, false, false, false);
    case ENTITLEMENT_STATES.ACTIVE:
      return caps(true, true, true, true, true);
    case ENTITLEMENT_STATES.GRACE:
      // Grace keeps everything except provisioning a new device.
      return caps(true, true, true, true, false);
    case ENTITLEMENT_STATES.EXPIRED:
    case ENTITLEMENT_STATES.REVOKED:
      // Expired and Revoked share a capability set (D-14). Revoked differs only in banner volume.
      return caps(true, true, true, false, false);
    case ENTITLEMENT_STATES.CLOCK_ANOMALY:
    case ENTITLEMENT_STATES.MALFORMED:
      // "Hold the previous state" — the caller keeps whatever capabilities it last legitimately had.
      return null;
    default:
      return null;
  }
};

/**
 * The §2.2 billing invariant: billing is available in every state EXCEPT Unprovisioned.
 *
 * This is asserted directly rather than derived from capabilities, because the "hold previous
 * state" states (ClockAnomaly, Malformed) have null capabilities yet must still bill. A shop that
 * is running never stops billing — not on expiry, not on revocation, not on a clock anomaly, not
 * on a corrupt entitlement.
 */
export const billingAllowed = (state) => state !== ENTITLEMENT_STATES.UNPROVISIONED;

/** True only for the states that hold the previously computed capability set. */
export const holdsPreviousState = (state) =>
  state === ENTITLEMENT_STATES.CLOCK_ANOMALY || state === ENTITLEMENT_STATES.MALFORMED;

// Choose the most specific date available for a "since"/"until" reference without ever rendering
// a blank. Per CLAUDE.md "errors must never render as zero" the copy functions must not emit empty
// strings; date fragments are appended only when present.
const dateFragment = (value) => {
  const text = String(value == null ? "" : value).trim();
  return text ? ` (${text})` : "";
};

const contactFragment = (contact) => {
  const text = String(contact == null ? "" : contact).trim();
  return text ? ` Contact ${text} to restore full access.` : " Contact the FroozERP owner to restore full access.";
};

/**
 * Banner descriptor for a state, or `null` when the state shows no banner (Active, Unprovisioned).
 * Copy is short, factual and Owner/INR-neutral. No branch produces a blank title or message.
 */
export const bannerForState = (state, { expiresAt, graceUntil, daysRemaining, contact } = {}) => {
  switch (state) {
    case ENTITLEMENT_STATES.ACTIVE:
    case ENTITLEMENT_STATES.UNPROVISIONED:
      // Active is the normal screen; Unprovisioned is handled by the activation screen, not a banner.
      return null;
    case ENTITLEMENT_STATES.GRACE: {
      const days = Number.isFinite(daysRemaining) ? Math.max(0, Math.trunc(daysRemaining)) : null;
      const daysText = days == null ? "soon" : `${days} ${days === 1 ? "day" : "days"}`;
      return {
        severity: "warning",
        dismissible: true,
        title: "Activation in grace period",
        message: `This activation has lapsed and is in its grace period, with ${daysText} remaining. Renew it before the grace period ends to avoid losing admin access.`,
      };
    }
    case ENTITLEMENT_STATES.EXPIRED:
      return {
        severity: "error",
        dismissible: false,
        title: "Activation expired",
        message: `This activation has Expired${dateFragment(graceUntil || expiresAt)}. Billing continues, but admin and settings are locked.${contactFragment(contact)}`,
      };
    case ENTITLEMENT_STATES.REVOKED:
      // Louder than Expired (D-14): same capabilities, but this device has been deliberately revoked.
      return {
        severity: "error",
        dismissible: false,
        title: "Activation revoked — this device should not be operating",
        message: `This device's activation has been Revoked. Billing continues so business is not interrupted, but admin and settings are locked and this state syncs back to the owner.${contactFragment(contact)}`,
      };
    case ENTITLEMENT_STATES.CLOCK_ANOMALY:
      return {
        severity: "warning",
        dismissible: false,
        title: "Device clock could not be trusted",
        message: "The device clock could not be trusted, so the last known activation state is being held. Correct the system date and time to resume normal activation checks.",
      };
    case ENTITLEMENT_STATES.MALFORMED:
      return {
        severity: "error",
        dismissible: false,
        title: "Activation could not be read",
        message: "The activation could not be read, so the last known activation state is being held. Re-import a valid activation file to restore normal checks.",
      };
    default:
      return null;
  }
};
