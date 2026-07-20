import assert from "node:assert/strict";
import test from "node:test";
import {
  FROST_CLOUD_UNAVAILABLE_MESSAGE,
  deriveRuntimeConnectivity,
  getFrostAvailabilityMessage,
  isCloudUnavailableError,
} from "./cloudAvailability.js";

test("local backend and cloud connectivity remain independent", () => {
  assert.deepEqual(deriveRuntimeConnectivity({
    localHealth: { online: true },
    internetAvailable: false,
    cloudHealth: { online: false },
    deviceApproved: true,
  }), {
    localServerConnected: true,
    internetAvailable: false,
    cloudConnected: false,
    syncAvailable: false,
  });
});

test("DNS, timeout, connection, and upstream gateway failures are cloud unavailable", () => {
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK"]) {
    assert.equal(isCloudUnavailableError({ code }), true, code);
  }
  for (const status of [502, 503, 504]) {
    assert.equal(isCloudUnavailableError({ response: { status } }), true, String(status));
  }
});

test("FROST presents one clean cloud-offline state without raw transport details", () => {
  const error = Object.assign(new Error("getaddrinfo ENOTFOUND froozerp-production-27bb.up.railway.app"), { code: "ENOTFOUND" });
  assert.equal(getFrostAvailabilityMessage({ error }), FROST_CLOUD_UNAVAILABLE_MESSAGE);
  assert.doesNotMatch(getFrostAvailabilityMessage({ error }), /ENOTFOUND|railway\.app/);
  assert.equal(getFrostAvailabilityMessage({ internetAvailable: false }), FROST_CLOUD_UNAVAILABLE_MESSAGE);
});

test("cloud recovery enables sync only after all independent prerequisites recover", () => {
  const recovered = deriveRuntimeConnectivity({
    localHealth: { online: true },
    internetAvailable: true,
    cloudHealth: { online: true },
    deviceApproved: true,
  });
  assert.equal(recovered.cloudConnected, true);
  assert.equal(recovered.syncAvailable, true);
});
