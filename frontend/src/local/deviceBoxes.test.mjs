import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { canRetireDeviceId, normalizeMachineFingerprint, previousDeviceIds, previousIdsNote, retireDeviceConfirmText } from "./deviceBoxes.js";

const FP = "a".repeat(64);

test("only a 64-character hex fingerprint is sent; anything else is nothing", () => {
  assert.equal(normalizeMachineFingerprint(` ${FP.toUpperCase()} `), FP);
  assert.equal(normalizeMachineFingerprint("a".repeat(63)), "");
  assert.equal(normalizeMachineFingerprint("{6F9619FF-8B86-D011-B42D-00C04FC964FF}"), "", "a raw Windows machine id is never passed on");
  assert.equal(normalizeMachineFingerprint(undefined), "");
  assert.equal(normalizeMachineFingerprint(42), "");
});

test("a box lists its machine's older ids once, never its own", () => {
  const device = { device_id: "FZDEV-NEW", previous_device_ids: ["FZDEV-OLD", "FZDEV-NEW", "", "FZDEV-OLD", "FZDEV-DELL-1"] };
  assert.deepEqual(previousDeviceIds(device), ["FZDEV-OLD", "FZDEV-DELL-1"]);
  assert.match(previousIdsNote(device), /^2 older ids on this machine: FZDEV-OLD, FZDEV-DELL-1$/);
  assert.equal(previousIdsNote({ device_id: "X" }), "");
  assert.match(previousIdsNote({ device_id: "X", previous_device_ids: ["Y"] }), /^Older id on this machine: Y$/);
});

test("the Owner can retire an old id, but never the computer in use", () => {
  assert.equal(canRetireDeviceId({ deviceId: "FZDEV-OLD", currentDeviceId: "FZDEV-NEW", isOwner: true }), true);
  assert.equal(canRetireDeviceId({ deviceId: "FZDEV-NEW", currentDeviceId: " FZDEV-NEW ", isOwner: true }), false);
  assert.equal(canRetireDeviceId({ deviceId: "FZDEV-OLD", currentDeviceId: "FZDEV-NEW", isOwner: false }), false);
  assert.equal(canRetireDeviceId({ deviceId: "", currentDeviceId: "X", isOwner: true }), false);
  assert.match(retireDeviceConfirmText({ device_id: "FZDEV-OLD", device_name: "DELL - FroozERP" }), /FZDEV-OLD \(DELL - FroozERP\)[\s\S]*bills stay in the books/);
});

test("the app sends the fingerprint with its device and shows folded ids and a retire action", () => {
  const app = readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
  assert.match(app, /machine_fp: normalizeMachineFingerprint\(identity\.machine_fp\)/);
  assert.match(app, /machine_fp: normalizeMachineFingerprint\(latestDevice\.machine_fp\)/);
  assert.match(app, /previousIdsNote\(/);
  assert.match(app, /\/api\/v3\/admin\/devices\/\$\{encodeURIComponent\(device\.device_id\)\}\/retire/);
  assert.match(app, /className="cell-note device-id-note"/);
});

test("a request folded out of the waiting list is named on the approved box", async () => {
  const { waitingIdsNote } = await import("./deviceBoxes.js");
  assert.equal(waitingIdsNote({ device_id: "FZDEV-A", waiting_device_ids: [] }), "");
  assert.equal(waitingIdsNote({ device_id: "FZDEV-A" }), "");
  assert.match(waitingIdsNote({ device_id: "FZDEV-A", waiting_device_ids: ["FZDEV-B", "FZDEV-A"] }), /asking to join as FZDEV-B\. If it cannot sign in, retire this old id/);
});

test("an id still asking to join is named once, as waiting, not also as an older id", async () => {
  const { waitingIdsNote } = await import("./deviceBoxes.js");
  const box = { device_id: "FZDEV-A", previous_device_ids: ["FZDEV-B", "FZDEV-C"], waiting_device_ids: ["FZDEV-B"] };
  assert.deepEqual(previousDeviceIds(box), ["FZDEV-C"]);
  assert.match(waitingIdsNote(box), /FZDEV-B/);
});
