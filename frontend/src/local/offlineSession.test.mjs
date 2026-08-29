import assert from "node:assert/strict";
import test from "node:test";
import { buildOfflineSessionRecord, verifyOfflineSessionRecord } from "./offlineSession.js";

test("offline login remains available after one successful online session", async () => {
  const session = await buildOfflineSessionRecord({
    username: "Owner",
    password: "local-test-password",
    user: { id: 1, role: "Owner", branch_id: 1 },
    deviceId: "clean-device-001",
    branchId: 1,
    lastSuccessfulSyncAt: "2026-07-14T00:00:00.000Z",
  });
  const result = await verifyOfflineSessionRecord(session, {
    username: "owner",
    password: "local-test-password",
    deviceId: "clean-device-001",
  });
  assert.equal(result.ok, true);
  assert.equal(result.session.user.role, "Owner");
});

test("NO_SESSION stops instructing an action the user may be unable to perform", async () => {
  const result = await verifyOfflineSessionRecord(null, {
    username: "owner",
    password: "local-test-password",
    deviceId: "clean-device-001",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "NO_SESSION");
  // Backlog item 5.3: telling a user to connect to the internet is unsatisfiable when the
  // backend is gone.
  assert.doesNotMatch(result.message, /connect to the internet/i);
  assert.match(result.message, /no offline sign-in record for this user/i);
});

test("NO_SESSION no longer denies that on-device activation exists", async () => {
  // Stage 5 shipped the .lic activation route, so the old sentence - "on-device activation is not
  // part of this build yet" - became false. A locked-out owner reading it would give up while a
  // working door stood open, which is worse than the original defect it replaced.
  const result = await verifyOfflineSessionRecord(null, {
    username: "owner",
    password: "local-test-password",
    deviceId: "clean-device-001",
  });
  assert.doesNotMatch(result.message, /not part of this build/i);
  // And it must not overclaim in the other direction either. A .lic file provisions a device, not
  // a person, so this message must not promise activation as a fix for an unknown user.
  assert.doesNotMatch(result.message, /activation file|\.lic/i);
  // What it must do is name the route that genuinely still works.
  assert.match(result.message, /already signed in/i);
});

test("offline session remains bound to its approved device", async () => {
  const session = await buildOfflineSessionRecord({
    username: "Owner",
    password: "local-test-password",
    user: { id: 1, role: "Owner", branch_id: 1 },
    deviceId: "device-a",
    branchId: 1,
  });
  const result = await verifyOfflineSessionRecord(session, {
    username: "owner",
    password: "local-test-password",
    deviceId: "device-b",
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, "DEVICE_MISMATCH");
});
