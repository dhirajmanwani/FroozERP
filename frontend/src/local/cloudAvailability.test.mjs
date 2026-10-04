import assert from "node:assert/strict";
import test from "node:test";
import {
  FROST_CLOUD_UNAVAILABLE_MESSAGE,
  deriveRuntimeConnectivity,
  getFrostAvailabilityMessage,
  isCloudUnavailableError,
  preserveVerifiedLocalCollection,
  preserveVerifiedLocalValue,
} from "./cloudAvailability.js";
import { readFileSync } from "node:fs";

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
  for (const code of ["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ECONNABORTED", "ETIMEDOUT", "ERR_NETWORK", "APP_LOCAL_ONLY"]) {
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

test("empty optional cloud collections never replace verified local business data", () => {
  const localProducts = [{ id: 1, name: "Preserved product" }];
  assert.equal(preserveVerifiedLocalCollection([], localProducts), localProducts);
  assert.equal(preserveVerifiedLocalCollection(undefined, localProducts), localProducts);
  assert.deepEqual(preserveVerifiedLocalCollection([{ id: 2 }], localProducts), [{ id: 2 }]);
  assert.deepEqual(preserveVerifiedLocalCollection([], []), []);
});

test("an object answer such as the settings bundle is kept, not turned into []", () => {
  const cloudSettings = { roles: [{ role_name: "Cashier", permissions: { billing: true } }], businessSettings: { shop_name: "A" } };
  assert.equal(preserveVerifiedLocalValue(cloudSettings, {}), cloudSettings);
  assert.equal(preserveVerifiedLocalValue(cloudSettings, { roles: [] }), cloudSettings);
  const cached = { roles: [{ role_name: "Cashier" }] };
  assert.equal(preserveVerifiedLocalValue(undefined, cached), cached, "no usable answer keeps the cached object");
  assert.equal(preserveVerifiedLocalValue("", cached), cached);
  assert.deepEqual(preserveVerifiedLocalValue(null, undefined), {});
});

test("collections keep the collection rule", () => {
  const local = [{ id: 1 }];
  assert.equal(preserveVerifiedLocalValue([], local), local);
  assert.equal(preserveVerifiedLocalValue({ message: "x" }, local), local);
  assert.deepEqual(preserveVerifiedLocalValue([{ id: 2 }], local), [{ id: 2 }]);
  assert.deepEqual(preserveVerifiedLocalValue([{ id: 2 }], {}), [{ id: 2 }]);
});

test("the sign-in reference requests use the object-aware rule, so role permissions arrive", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const start = app.indexOf("const fetchOnlineReferenceSnapshot = async");
  const body = app.slice(start, app.indexOf("const settingsPayload = values.settings", start));
  assert.ok(start > 0 && body.length > 0);
  assert.match(body, /\["settings", "\/settings", localBundle\]/);
  assert.match(body, /preserveVerifiedLocalValue\(response\.data, fallback\)/);
  assert.doesNotMatch(body, /preserveVerifiedLocalCollection\(response\.data/);
});
