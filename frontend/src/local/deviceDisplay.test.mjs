import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { deviceKind, deviceSeenParts, formatDeviceDate, shortDeviceId } from "./deviceDisplay.js";

const app = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const css = fs.readFileSync(new URL("../App.css", import.meta.url), "utf8");

test("a long device id keeps its start and end; a short one is left alone", () => {
  assert.equal(shortDeviceId("FZDEV-D2328EAF-7C41-4B9E-A0D3-5F18C2E94B71"), "FZDEV-D2328EAF…4B71");
  assert.equal(shortDeviceId("FZDEV-ANDROID-9a3f7c21e5b84d06b1c2f8e7d4a90c3e"), "FZDEV-ANDROID-9a3f…0c3e");
  assert.equal(shortDeviceId("audit-device-0001"), "audit-device-0001");
  assert.equal(shortDeviceId(""), "");
  assert.equal(shortDeviceId(null), "");
  // Two different ids never collapse to the same short form when their ends differ.
  assert.notEqual(shortDeviceId("FZDEV-D2328EAF-7C41-4B9E-A0D3-5F18C2E94B71"), shortDeviceId("FZDEV-D2328EAF-7C41-4B9E-A0D3-5F18C2E90000"));
});

test("the kind chosen in Step 4 wins over what the app reported about itself", () => {
  assert.equal(deviceKind({ assignedType: "LAPTOP", platform: "tauri-windows" }).label, "Laptop");
  assert.equal(deviceKind({ assignedType: "ANDROID_PHONE" }).icon, "phone");
  assert.equal(deviceKind({ platform: "android" }).label, "Android phone");
  assert.equal(deviceKind({ platform: "tauri-windows" }).label, "Windows computer");
  assert.equal(deviceKind({ reportedType: "Browser" }).label, "Browser");
  assert.equal(deviceKind({}).label, "Computer");
  assert.equal(deviceKind().icon, "monitor");
});

test("dates read as words, and an unreadable value is never shown as a made-up date", () => {
  assert.equal(formatDeviceDate("2027-10-30"), "30 Oct 2027");
  assert.equal(formatDeviceDate("2027-10-30T00:00:00Z"), "30 Oct 2027");
  assert.equal(formatDeviceDate("not a date"), "not a date");
  assert.equal(formatDeviceDate(""), "");
  assert.equal(deviceSeenParts(""), null);
  assert.equal(deviceSeenParts("garbage"), null);
  const seen = deviceSeenParts("2026-10-30T18:45:00");
  assert.equal(seen.date, "30 Oct 2026");
  assert.equal(seen.time, "6:45 pm");
  assert.equal(deviceSeenParts("2026-10-30T00:05:00").time, "12:05 am");
});

test("every device table names a machine the same way and cannot spill into the next cell", () => {
  // Step 4 waiting + approved, Step 5 licence list + issued licences.
  assert.ok((app.match(/<DeviceIdentity /g) || []).length >= 4, "each device table uses DeviceIdentity");
  assert.equal((app.match(/className="device-table/g) || []).length, 3, "the three device tables share one class");
  assert.match(app, /className="device-id-chip" title=\{id\}/, "the full id stays on the tooltip");
  assert.match(css, /\.device-table td\.device-cell \{[^}]*white-space: normal;[^}]*min-width: \d+px;/s, "the name column wraps and has a floor");
  assert.match(css, /\.device-identity-name \{[^}]*overflow-wrap: anywhere;[^}]*-webkit-line-clamp: 2;/s, "a name stops at two lines");
  assert.match(css, /\.device-id-chip \{[^}]*text-overflow: ellipsis;/s, "the id chip never runs out of its cell");
});
