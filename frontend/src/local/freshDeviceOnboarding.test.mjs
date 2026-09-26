import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  approvedDeviceCredentialMessage,
  describeInitialPullFailure,
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

test("a refused first download is described with the server's code and words", () => {
  const error = Object.assign(new Error("Request failed with status code 409"), {
    response: { status: 409, data: { code: "OPERATIONAL_SCOPE_REQUIRED", message: "Reference bootstrap requires enforced operational-location scope" } },
  });
  const failure = describeInitialPullFailure(error);
  assert.deepEqual(failure.log, {
    code: "OPERATIONAL_SCOPE_REQUIRED",
    status: 409,
    message: "Reference bootstrap requires enforced operational-location scope",
  });
  assert.match(failure.notice, /OPERATIONAL_SCOPE_REQUIRED/);
  assert.match(failure.notice, /loaded the ordinary way/);
});

test("a first download with no answer still says something", () => {
  const failure = describeInitialPullFailure(new Error("Network Error"));
  assert.equal(failure.log.status, null);
  assert.equal(failure.log.message, "Network Error");
  assert.equal(describeInitialPullFailure(undefined).log.code, "INITIAL_PULL_FAILED");
});

test("sign-in on a new device carries on to the reference snapshot when the first download fails", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("const hydrateOnlineSession = async");
  const body = app.slice(start, app.indexOf("const continueOffline = async", start));
  const pull = body.indexOf("initialPullForApprovedDevice({");
  const guard = body.lastIndexOf("try {", pull);
  const caught = body.indexOf("describeInitialPullFailure(", pull);
  const snapshot = body.indexOf("fetchOnlineReferenceSnapshot(");
  assert.ok(guard >= 0 && guard < pull, "the first download must sit inside a try");
  assert.ok(caught > pull && caught < snapshot, "its failure must be caught before the snapshot step");
  assert.match(body, /writeDiagnosticLog\("WARN", "initial-pull-failed"/);
});
