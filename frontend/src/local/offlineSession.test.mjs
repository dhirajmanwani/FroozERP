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
