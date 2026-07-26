import assert from "node:assert/strict";
import test from "node:test";
import {
  approvedDeviceCredentialMessage,
  normalizeDeviceBootstrapStatus,
} from "./freshDeviceOnboarding.js";

test("normalizes approved post-approval state", () => {
  assert.deepEqual(normalizeDeviceBootstrapStatus({
    code: "DEVICE_APPROVED",
    device_id: "FZDEV-TEST",
    device_status: "APPROVED",
    approved: true,
  }), {
    code: "DEVICE_APPROVED",
    device_id: "FZDEV-TEST",
    device_status: "APPROVED",
    approved: true,
    company_id: null,
    branch_id: null,
  });
});

test("normalizes pending state without treating it as invalid credentials", () => {
  const status = normalizeDeviceBootstrapStatus({
    device_id: "FZDEV-TEST",
    device_status: "PENDING",
  });
  assert.equal(status.code, "DEVICE_PENDING_APPROVAL");
  assert.equal(status.approved, false);
});

test("canonical credential guidance is limited to the explicit server code", () => {
  assert.match(approvedDeviceCredentialMessage({
    code: "CANONICAL_CREDENTIALS_REQUIRED",
  }), /canonical FroozERP account/);
  assert.equal(approvedDeviceCredentialMessage({ code: "INVALID_CREDENTIALS" }), "");
});
