/**
 * The matrix that was previously collapsed into one boolean.
 *
 * The regression these guard against is specific and was found on real hardware: a device
 * activated from a signed `.lic` could not open a single module, and could not log in at all on
 * the next restart, because `reference_ready` (which measures *data*) was being read as
 * *authorisation*. Every "entitled + empty" row below is a device that used to be bricked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  hasSyncedBefore,
  OFFLINE_OPEN_CODES,
  resolveOfflineOpenDecision,
} from "./offlineDataReadiness.js";
import { ENTITLEMENT_STATES } from "./entitlementState.js";

const snapshot = ({ ready = false, syncedAt = null } = {}) => ({
  reference_ready: ready,
  last_successful_sync_at: syncedAt,
});

test("an entitled device with data opens with nothing to report", () => {
  const decision = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: true, syncedAt: "2026-08-18T04:00:00.000Z" }),
    entitlementState: ENTITLEMENT_STATES.ACTIVE,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, OFFLINE_OPEN_CODES.READY);
  assert.equal(decision.empty, false);
  assert.equal(decision.suspicious, false);
  assert.equal(decision.message, "");
});

test("a freshly activated device with no data opens instead of being locked out", () => {
  // The exact case that failed on Windows: activated from a .lic, never synced, zero products.
  const decision = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: false, syncedAt: null }),
    entitlementState: ENTITLEMENT_STATES.ACTIVE,
  });
  assert.equal(decision.allowed, true, "an activated device must never be refused for being empty");
  assert.equal(decision.code, OFFLINE_OPEN_CODES.EMPTY_NEW_DEVICE);
  assert.equal(decision.empty, true);
  assert.equal(decision.suspicious, false);
  assert.match(decision.message, /Products module/);
  assert.doesNotMatch(
    decision.message,
    /connect to the internet/i,
    "the message must not prescribe the impossible action this feature removed",
  );
});

test("an empty device that has synced before is opened but flagged, never shown silent zeros", () => {
  // CLAUDE.md: a failed load or internal inconsistency must produce a distinct state, not a zero.
  const decision = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: false, syncedAt: "2026-08-17T09:15:00.000Z" }),
    entitlementState: ENTITLEMENT_STATES.ACTIVE,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, OFFLINE_OPEN_CODES.EMPTY_AFTER_SYNC);
  assert.equal(decision.empty, true);
  assert.equal(decision.suspicious, true, "empty after a successful sync is a symptom, not a start");
  assert.match(decision.message, /may be incomplete/);
});

test("every state that may bill may also open, empty or not", () => {
  // Tied to the §2.2 invariant on purpose: a device permitted to bill must be able to reach the
  // screens it bills from. Grace/Expired/Revoked/ClockAnomaly/Malformed all keep billing.
  const billingStates = Object.values(ENTITLEMENT_STATES).filter(
    (state) => state !== ENTITLEMENT_STATES.UNPROVISIONED,
  );
  for (const state of billingStates) {
    const decision = resolveOfflineOpenDecision({
      snapshot: snapshot({ ready: false }),
      entitlementState: state,
    });
    assert.equal(decision.allowed, true, `${state} may bill, so it must be able to open`);
  }
});

test("an unprovisioned device with no data is still refused, and told the route that works", () => {
  const decision = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: false }),
    entitlementState: ENTITLEMENT_STATES.UNPROVISIONED,
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, OFFLINE_OPEN_CODES.NOT_PROVISIONED);
  assert.match(decision.message, /\.lic/, "it must name the local activation route (backlog item 5)");
});

test("an unprovisioned device that holds data is never shut out of it", () => {
  // A real installation whose grandfathering has not run yet. Blocking it would brick exactly the
  // population §11.1 protects.
  const decision = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: true }),
    entitlementState: ENTITLEMENT_STATES.UNPROVISIONED,
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.code, OFFLINE_OPEN_CODES.READY);
});

test("an unknown entitlement falls back to the legacy behaviour in both directions", () => {
  // A status read that failed, or a browser runtime. Assume nothing; behave as before.
  const withData = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: true }),
    entitlementState: null,
  });
  assert.equal(withData.allowed, true);

  const withoutData = resolveOfflineOpenDecision({
    snapshot: snapshot({ ready: false }),
    entitlementState: null,
  });
  assert.equal(withoutData.allowed, false);
  assert.equal(withoutData.code, OFFLINE_OPEN_CODES.NOT_PROVISIONED);
});

test("a missing snapshot is treated as empty, not as ready", () => {
  const decision = resolveOfflineOpenDecision({ snapshot: null, entitlementState: null });
  assert.equal(decision.allowed, false);
  assert.equal(decision.empty, true);
});

test("no decision ever produces a blank message when it has something to report", () => {
  // "Errors must never render as zero" applied to copy: any non-READY code must say something.
  const cases = [
    { snapshot: snapshot({ ready: false }), entitlementState: ENTITLEMENT_STATES.ACTIVE },
    { snapshot: snapshot({ ready: false, syncedAt: "2026-08-17T09:15:00.000Z" }), entitlementState: ENTITLEMENT_STATES.ACTIVE },
    { snapshot: snapshot({ ready: false }), entitlementState: ENTITLEMENT_STATES.UNPROVISIONED },
  ];
  for (const input of cases) {
    const decision = resolveOfflineOpenDecision(input);
    assert.notEqual(decision.code, OFFLINE_OPEN_CODES.READY);
    assert.ok(decision.message.trim().length > 0, `${decision.code} must carry copy`);
  }
});

test("hasSyncedBefore ignores absent, empty and whitespace timestamps", () => {
  assert.equal(hasSyncedBefore({ last_successful_sync_at: "2026-08-18T04:00:00.000Z" }), true);
  assert.equal(hasSyncedBefore({ last_successful_sync_at: "" }), false);
  assert.equal(hasSyncedBefore({ last_successful_sync_at: "   " }), false);
  assert.equal(hasSyncedBefore({ last_successful_sync_at: null }), false);
  assert.equal(hasSyncedBefore({}), false);
  assert.equal(hasSyncedBefore(null), false);
});
