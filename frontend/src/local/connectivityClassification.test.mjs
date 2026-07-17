import assert from "node:assert/strict";
import test from "node:test";
import { classifyHealthError, describeCloudUnavailableSync, isCloudTransportFailure } from "./connectivityService.js";
import { classifySyncError } from "./syncClassification.js";

test("cloud network failure is not labelled as a local backend failure", () => {
  const error = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
  assert.deepEqual(classifyHealthError(error, { requireCloudIdentity: true }), {
    reasonCode: "NO_NETWORK",
    reachabilityStatus: "offline",
    message: "Internet is offline or FroozERP cloud is temporarily unavailable.",
  });
  assert.deepEqual(classifySyncError(error, "https://froozerp-production-27bb.up.railway.app"), {
    online: false,
    kind: "CLOUD_UNAVAILABLE",
    message: "Cloud temporarily unavailable - sync paused until internet returns.",
    status: null,
  });
});

test("local backend failures remain explicitly local", () => {
  const error = Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });
  assert.equal(classifyHealthError(error).message, "The local FroozERP service is unreachable.");
  assert.match(classifySyncError(error, "http://127.0.0.1:5000").message, /^Local FroozERP service unreachable/);
});

test("cloud transport failure kinds are isolated from authorization failures", () => {
  for (const kind of ["NO_NETWORK", "BACKEND_UNREACHABLE", "CLOUD_UNAVAILABLE", "TIMEOUT"]) {
    assert.equal(isCloudTransportFailure(kind), true);
  }
  assert.equal(isCloudTransportFailure("AUTHORIZATION"), false);
  assert.equal(isCloudTransportFailure("DEVICE_AUTHORIZATION"), false);
});

test("healthy local runtime with unavailable cloud reports a paused cloud sync", () => {
  assert.equal(describeCloudUnavailableSync({
    localOnline: true,
    usesCloud: true,
    internetAvailable: false,
    cloudOffline: true,
    lastFailureKind: "CLOUD_UNAVAILABLE",
    pending: 0,
  }), "Local ready - cloud unavailable; sync paused until internet returns.");
  assert.equal(describeCloudUnavailableSync({
    localOnline: false,
    usesCloud: true,
    internetAvailable: false,
    cloudOffline: true,
    lastFailureKind: "CLOUD_UNAVAILABLE",
    pending: 0,
  }), "");
});
