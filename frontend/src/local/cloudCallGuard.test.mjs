import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  CLOUD_CALL_REFUSAL_CODES,
  assertCloudCallAllowed,
  createCloudCallGuard,
  createCloudCallRefusalError,
  evaluateCloudCall,
} from "./cloudCallGuard.js";

const CLOUD = "https://cloud.example.com";

test("a fully configured, unblocked call is allowed and carries a normalized target", () => {
  const decision = evaluateCloudCall({ operation: "sync-push", target: `${CLOUD}/`, localOnly: false, apiMode: "HYBRID" });
  assert.equal(decision.allowed, true);
  assert.equal(decision.blocked, false);
  assert.equal(decision.target, CLOUD);
  assert.equal(decision.code, "");
});

test("API_MODE=LOCAL_ONLY outranks everything, including a healthy connectivity policy", () => {
  const decision = evaluateCloudCall({ operation: "canonical-cloud-login", target: CLOUD, localOnly: false, apiMode: "LOCAL_ONLY" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, CLOUD_CALL_REFUSAL_CODES.API_MODE_LOCAL_ONLY);
  assert.equal(decision.blocked, true);
  assert.equal(decision.reachedCloud, false);
  assert.equal(evaluateCloudCall({ target: CLOUD, apiMode: "local" }).allowed, false);
});

test("the Owner connectivity kill switch refuses a configured cloud target", () => {
  const decision = evaluateCloudCall({ operation: "device-bootstrap-status", target: CLOUD, localOnly: true, apiMode: "HYBRID" });
  assert.equal(decision.allowed, false);
  assert.equal(decision.code, CLOUD_CALL_REFUSAL_CODES.APP_LOCAL_ONLY);
  assert.equal(decision.reachedCloud, false);
});

test("an unconfigured target refuses by name instead of degrading into a relative request", () => {
  for (const target of ["", "   ", undefined, null]) {
    const decision = evaluateCloudCall({ operation: "sync-pull", target, localOnly: false, apiMode: "HYBRID" });
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, CLOUD_CALL_REFUSAL_CODES.CLOUD_NOT_CONFIGURED);
    assert.equal(decision.blocked, true);
    assert.equal(decision.reachedCloud, false);
  }
});

test("refusal precedence reports the most authoritative reason", () => {
  assert.equal(
    evaluateCloudCall({ target: "", localOnly: true, apiMode: "LOCAL_ONLY" }).code,
    CLOUD_CALL_REFUSAL_CODES.API_MODE_LOCAL_ONLY,
  );
  assert.equal(
    evaluateCloudCall({ target: "", localOnly: true, apiMode: "HYBRID" }).code,
    CLOUD_CALL_REFUSAL_CODES.APP_LOCAL_ONLY,
  );
});

test("no decision ever reports having reached the cloud", () => {
  const cases = [
    { target: CLOUD, localOnly: false, apiMode: "HYBRID" },
    { target: CLOUD, localOnly: true, apiMode: "HYBRID" },
    { target: "", localOnly: false, apiMode: "LOCAL_SINGLE_DEVICE" },
    { target: CLOUD, localOnly: false, apiMode: "LOCAL_ONLY" },
  ];
  for (const input of cases) assert.equal(evaluateCloudCall(input).reachedCloud, false);
});

test("assertion form throws a named error carrying the refusal code", () => {
  assert.throws(
    () => assertCloudCallAllowed({ operation: "login", target: "", apiMode: "HYBRID" }),
    (error) => error.code === "CLOUD_NOT_CONFIGURED" && error.reachedCloud === false && error.operation === "login",
  );
  assert.equal(assertCloudCallAllowed({ operation: "login", target: CLOUD, apiMode: "HYBRID" }).allowed, true);
  const error = createCloudCallRefusalError(evaluateCloudCall({ target: CLOUD, localOnly: true }));
  assert.equal(error.code, "APP_LOCAL_ONLY");
});

test("a bound guard reads live connectivity on every evaluation", () => {
  let localOnly = false;
  const guard = createCloudCallGuard({ apiMode: "HYBRID", isLocalOnly: () => localOnly });
  assert.equal(guard.evaluate("sync-push", CLOUD).allowed, true);
  localOnly = true;
  assert.equal(guard.evaluate("sync-push", CLOUD).code, CLOUD_CALL_REFUSAL_CODES.APP_LOCAL_ONLY);
  assert.throws(() => guard.assert("sync-push", CLOUD), /Local Only mode selected/);

  const pinned = createCloudCallGuard({ apiMode: "LOCAL_ONLY", isLocalOnly: () => false });
  assert.equal(pinned.evaluate("sync-push", CLOUD).code, CLOUD_CALL_REFUSAL_CODES.API_MODE_LOCAL_ONLY);
});

test("App.jsx routes every cloud-bound call site through the guard", () => {
  const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");

  assert.match(appSource, /const cloudCallGuard = createCloudCallGuard\(\{[\s\S]*apiMode: API_MODE,[\s\S]*isLocalOnly: \(\) => isLocalOnlyConnectivitySelected\(\),/);
  for (const operation of [
    "canonical-cloud-login",
    "device-bootstrap-status",
    "background-sync",
    "sync-now",
    "purchase-rules",
  ]) {
    assert.match(appSource, new RegExp(`guardCloudCall\\("${operation}"`), `${operation} must be guarded`);
  }
  assert.match(appSource, /cloudCallGuard\.evaluate\("cloud-backend-health", CLOUD_OPERATIONAL_API_URL\)/);

  // The bootstrap probe and /login are guarded, not deleted -- removing them is later-stage work.
  assert.match(appSource, /\/api\/auth\/device-bootstrap-status/);
  assert.match(appSource, /axios\.post\(`\$\{AUTH_API_URL\}\/login`/);

  // Background sync no longer rests on `!localOnly` alone.
  assert.match(
    appSource,
    /const backgroundSyncGate = guardCloudCall\("background-sync", SYNC_API_URL\);\s*\n\s*const cloudReadyForSync = backgroundSyncGate\.allowed && \(!usesCloudBackend\(\) \|\| nextCloudHealth\?\.online === true\);/,
  );
  assert.match(appSource, /!localOnly && health\.online && cloudReadyForSync/);
});

test("FROST voice has no path to the cloud at all", () => {
  // This used to check that the OpenAI Realtime voice path asked the guard before opening the
  // microphone: it was the one FROST call that could open an external connection FROM THE COUNTER,
  // straight from the machine to the provider, where the gateway's LOCAL_ONLY block never saw it.
  // The intent -- LOCAL_ONLY keeps blocked=true, reachedCloud=false and external connections at 0
  // with the microphone on -- is now kept structurally rather than by a guard: that path is removed,
  // and live voice talks only to the desktop gateway on LOCAL_API_URL (/api/local/speech/*), where
  // speech-to-text runs on the laptop. The one external fetch left is the gateway's own one-time
  // engine download, which the gateway refuses in LOCAL_ONLY.
  const appSource = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.equal(appSource.includes("startFrostVoice"), false, "the realtime voice function is gone");
  assert.equal(appSource.includes("api/ai/voice/session"), false);
  assert.equal(appSource.includes("realtimeUrl"), false);
  assert.equal(appSource.includes("RTCPeerConnection"), false);
  assert.doesNotMatch(appSource, /guardCloudCall\("frost-realtime-voice/);
  // Every speech route is on the local gateway, never on a cloud base.
  const speechCalls = [...appSource.matchAll(/axios\.(?:get|post)\(`\$\{(\w+)\}\/api\/local\/speech\//g)];
  assert.ok(speechCalls.length >= 3, "status, install and transcribe are all called");
  assert.deepEqual([...new Set(speechCalls.map((match) => match[1]))], ["LOCAL_API_URL"]);
});

test("every refusal the guard can return carries a message the owner can act on", () => {
  // Written for the realtime voice gate, which is gone; the property it pinned is the guard's own
  // and every FROST cloud call still depends on it.
  for (const code of Object.values(CLOUD_CALL_REFUSAL_CODES)) {
    const decision = evaluateCloudCall({
      operation: "frost-query",
      target: code === CLOUD_CALL_REFUSAL_CODES.CLOUD_NOT_CONFIGURED ? "" : "https://cloud.example.com",
      localOnly: code === CLOUD_CALL_REFUSAL_CODES.APP_LOCAL_ONLY,
      apiMode: code === CLOUD_CALL_REFUSAL_CODES.API_MODE_LOCAL_ONLY ? "LOCAL_ONLY" : "",
    });
    assert.equal(decision.allowed, false, code);
    assert.equal(decision.blocked, true);
    assert.equal(decision.reachedCloud, false);
    assert.ok(decision.message.length > 20, `${code} has no usable message`);
  }
});
