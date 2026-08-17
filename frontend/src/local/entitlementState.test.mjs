import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ENTITLEMENT_STATES,
  capabilitiesForState,
  billingAllowed,
  holdsPreviousState,
  bannerForState,
} from "./entitlementState.js";

const ALL_STATES = Object.values(ENTITLEMENT_STATES);

// ---------------------------------------------------------------------------
// THE §2.2 BILLING INVARIANT — the single most important assertion in this file.
// Billing is available in every state EXCEPT Unprovisioned. Iterate the full state set so a newly
// added state cannot silently regress the invariant.
// ---------------------------------------------------------------------------
test("§2.2 invariant: billing is allowed in every state except Unprovisioned", () => {
  assert.ok(ALL_STATES.length >= 7, "state set should cover the whole §9 table");
  for (const state of ALL_STATES) {
    assert.equal(
      billingAllowed(state),
      state !== "Unprovisioned",
      `billingAllowed(${state}) must be ${state !== "Unprovisioned"}`,
    );
  }
  // Named-state spot checks so the intent is unmissable, including the null-capability states.
  assert.equal(billingAllowed(ENTITLEMENT_STATES.UNPROVISIONED), false);
  assert.equal(billingAllowed(ENTITLEMENT_STATES.ACTIVE), true);
  assert.equal(billingAllowed(ENTITLEMENT_STATES.GRACE), true);
  assert.equal(billingAllowed(ENTITLEMENT_STATES.EXPIRED), true);
  assert.equal(billingAllowed(ENTITLEMENT_STATES.REVOKED), true);
  assert.equal(billingAllowed(ENTITLEMENT_STATES.CLOCK_ANOMALY), true);
  assert.equal(billingAllowed(ENTITLEMENT_STATES.MALFORMED), true);
});

test("Unprovisioned denies every capability", () => {
  assert.deepEqual(capabilitiesForState(ENTITLEMENT_STATES.UNPROVISIONED), {
    billing: false,
    local_reports: false,
    sync: false,
    admin: false,
    provisioning: false,
  });
});

test("Active grants every capability", () => {
  assert.deepEqual(capabilitiesForState(ENTITLEMENT_STATES.ACTIVE), {
    billing: true,
    local_reports: true,
    sync: true,
    admin: true,
    provisioning: true,
  });
});

test("Grace keeps everything but loses provisioning", () => {
  assert.deepEqual(capabilitiesForState(ENTITLEMENT_STATES.GRACE), {
    billing: true,
    local_reports: true,
    sync: true,
    admin: true,
    provisioning: false,
  });
});

test("Expired and Revoked lose admin and provisioning but keep billing, reports, sync", () => {
  const expected = {
    billing: true,
    local_reports: true,
    sync: true,
    admin: false,
    provisioning: false,
  };
  assert.deepEqual(capabilitiesForState(ENTITLEMENT_STATES.EXPIRED), expected);
  assert.deepEqual(capabilitiesForState(ENTITLEMENT_STATES.REVOKED), expected);
});

test("ClockAnomaly and Malformed hold the previous state (null capabilities)", () => {
  assert.equal(capabilitiesForState(ENTITLEMENT_STATES.CLOCK_ANOMALY), null);
  assert.equal(capabilitiesForState(ENTITLEMENT_STATES.MALFORMED), null);
});

test("holdsPreviousState is true only for ClockAnomaly and Malformed", () => {
  for (const state of ALL_STATES) {
    const expected = state === "ClockAnomaly" || state === "Malformed";
    assert.equal(holdsPreviousState(state), expected, `holdsPreviousState(${state})`);
  }
});

test("cross-check: where capabilities is non-null, capabilities.billing equals billingAllowed", () => {
  for (const state of ALL_STATES) {
    const caps = capabilitiesForState(state);
    if (caps !== null) {
      assert.equal(caps.billing, billingAllowed(state), `capabilities.billing vs billingAllowed for ${state}`);
    }
  }
});

test("Active and Unprovisioned show no banner", () => {
  assert.equal(bannerForState(ENTITLEMENT_STATES.ACTIVE), null);
  assert.equal(bannerForState(ENTITLEMENT_STATES.UNPROVISIONED), null);
});

test("Grace banner is a dismissible warning naming days remaining", () => {
  const banner = bannerForState(ENTITLEMENT_STATES.GRACE, { daysRemaining: 12 });
  assert.equal(banner.severity, "warning");
  assert.equal(banner.dismissible, true);
  assert.match(banner.message, /12 days/);
  assert.ok(banner.title.length > 0 && banner.message.length > 0);
});

test("Expired banner is a non-dismissible error naming the state, date and contact", () => {
  const banner = bannerForState(ENTITLEMENT_STATES.EXPIRED, { graceUntil: "2026-08-01", contact: "the FroozERP owner" });
  assert.equal(banner.severity, "error");
  assert.equal(banner.dismissible, false);
  assert.match(banner.message, /Expired/);
  assert.match(banner.message, /2026-08-01/);
  assert.match(banner.message, /the FroozERP owner/);
});

test("Revoked banner is a non-dismissible error and louder than Expired (D-14)", () => {
  const expired = bannerForState(ENTITLEMENT_STATES.EXPIRED, {});
  const revoked = bannerForState(ENTITLEMENT_STATES.REVOKED, {});
  assert.equal(revoked.severity, "error");
  assert.equal(revoked.dismissible, false);
  assert.match(revoked.message, /Revoked/);
  // "Louder" — the revoked title carries an explicit should-not-operate warning the expired one lacks.
  assert.ok(revoked.title.length > expired.title.length, "revoked title should be louder than expired");
});

test("ClockAnomaly banner is a non-dismissible warning about an untrusted clock", () => {
  const banner = bannerForState(ENTITLEMENT_STATES.CLOCK_ANOMALY);
  assert.equal(banner.severity, "warning");
  assert.equal(banner.dismissible, false);
  assert.match(banner.message, /clock could not be trusted/i);
  assert.match(banner.message, /holding|held|last known/i);
});

test("Malformed banner is a non-dismissible error about an unreadable activation", () => {
  const banner = bannerForState(ENTITLEMENT_STATES.MALFORMED);
  assert.equal(banner.severity, "error");
  assert.equal(banner.dismissible, false);
  assert.match(banner.message, /could not be read/i);
  assert.match(banner.message, /holding|held|last known/i);
});

test("no banner renders a blank title or message (CLAUDE.md: errors never render as zero)", () => {
  for (const state of ALL_STATES) {
    const banner = bannerForState(state, {});
    if (banner !== null) {
      assert.ok(String(banner.title).trim().length > 0, `${state} banner title must not be blank`);
      assert.ok(String(banner.message).trim().length > 0, `${state} banner message must not be blank`);
    }
  }
  // Grace with no daysRemaining supplied must still produce non-blank copy, never "0 days" alone.
  const graceNoDays = bannerForState(ENTITLEMENT_STATES.GRACE, {});
  assert.ok(graceNoDays.message.trim().length > 0);
});
