import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  ENROLMENT_OUTCOME,
  describeEnrolmentAttempt,
  readPastedActivation,
} from "./activationEnrolment.js";

const refusal = (status, data) => ({ response: { status, data } });

test("a pending answer means the device now waits at the shop, with the Owner's steps", () => {
  const result = describeEnrolmentAttempt({
    error: refusal(403, { code: "DEVICE_PENDING_APPROVAL" }),
    deviceName: "Android Device 9F2C",
  });
  assert.equal(result.outcome, ENROLMENT_OUTCOME.WAITING_AT_SHOP);
  assert.equal(result.ok, true);
  assert.match(result.message, /Android Device 9F2C/);
  assert.match(result.message, /Device Activation Licences/);
});

test("a session answer means the shop already knows the device; the session is not the point", () => {
  const result = describeEnrolmentAttempt({ response: { status: 200, data: { token: "x" } } });
  assert.equal(result.outcome, ENROLMENT_OUTCOME.ALREADY_KNOWN);
  assert.equal(result.ok, true);
  assert.doesNotMatch(result.message, /token/);
});

test("wrong credentials are an error, never a success", () => {
  const result = describeEnrolmentAttempt({ error: refusal(401, { code: "INVALID_CREDENTIALS" }) });
  assert.equal(result.outcome, ENROLMENT_OUTCOME.WRONG_CREDENTIALS);
  assert.equal(result.ok, false);
});

test("a blocked device says the Owner blocked it", () => {
  for (const code of ["DEVICE_DISABLED", "DEVICE_REVOKED"]) {
    const result = describeEnrolmentAttempt({ error: refusal(403, { code }) });
    assert.equal(result.outcome, ENROLMENT_OUTCOME.BLOCKED);
    assert.equal(result.ok, false);
  }
});

test("no answer at all is unreachable, not a refusal and not a success", () => {
  const result = describeEnrolmentAttempt({ error: new Error("Network Error") });
  assert.equal(result.outcome, ENROLMENT_OUTCOME.UNREACHABLE);
  assert.equal(result.ok, false);
});

test("a Local Only refusal is reported in its own words and never reached the cloud", () => {
  const error = Object.assign(new Error("Local Only is on."), { blocked: true, reachedCloud: false });
  const result = describeEnrolmentAttempt({ error });
  assert.equal(result.outcome, ENROLMENT_OUTCOME.REFUSED);
  assert.equal(result.message, "Local Only is on.");
});

test("an unrecognised refusal is an error carrying the server's words", () => {
  const result = describeEnrolmentAttempt({ error: refusal(423, { code: "ACCOUNT_LOCKED", message: "Try again later." }) });
  assert.equal(result.ok, false);
  assert.equal(result.message, "Try again later.");
  assert.equal(describeEnrolmentAttempt({}).ok, false);
});

test("pasted activation text is trimmed, and empty text is refused in words", () => {
  assert.deepEqual(readPastedActivation("  abc\n"), { ok: true, contents: "abc" });
  assert.equal(readPastedActivation("   ").ok, false);
  assert.equal(readPastedActivation(null).ok, false);
});

test("the activation screen sends enrolment through the cloud guard and drops any session", () => {
  const source = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  const gate = source.slice(source.indexOf("function ActivationGate("), source.indexOf("function DeviceActivationIssuingSection("));
  assert.match(gate, /guardCloudCall\("activation-enrolment", AUTH_API_URL\)/);
  assert.match(gate, /describeEnrolmentAttempt\(/);
  assert.match(gate, /readPastedActivation\(/);
  assert.doesNotMatch(gate, /setUser\(|writeOfflineSession\(|localStorage\.setItem/);
});
