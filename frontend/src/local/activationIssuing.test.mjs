// What the Owner's activation-issuing screen is allowed to decide, and what it must refuse to
// guess. The screen itself (`App.jsx`) is 17k lines and untestable; everything that could be
// wrong lives in `activationIssuing.js`, so everything that could be wrong is in here.
//
// The source-text assertions at the end guard the handful of rules that can only live in
// App.jsx: who the section is for, that it never asks for a typed device id, and that the
// summary tiles are fed from the same call as the table.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { navigationRegistry } from "./appNavigation.js";
import {
  DEFAULT_VALID_DAYS,
  DEVICE_ACTIVATION_STATE,
  GRACE_DAYS,
  LICENCE_STATUS,
  LIC_CONTAINER_FORMAT,
  VALIDITY_PRESETS,
  VALID_DAYS_MAX,
  VALID_DAYS_MIN,
  WIRE_VALID_DAYS_MAX,
  buildActivationIssuingView,
  markAmbiguousDeviceNames,
  buildIssueRequest,
  classifyLicence,
  dayNumberToIso,
  deriveExpiryDay,
  deriveExpiryIso,
  describeDeviceActivation,
  describeIssueFailure,
  describeIssuedLicence,
  describeLicenceFileFailure,
  describeValidity,
  licenceFileName,
  licencesForDevice,
  orderDevicesForIssuing,
  toDayNumber,
  validateLicenceArtifact,
  validateValidDays,
} from "./activationIssuing.js";

const appSource = await readFile(new URL("../App.jsx", import.meta.url), "utf8");
const rustEntitlement = await readFile(new URL("../../../src-tauri/src/entitlement.rs", import.meta.url), "utf8");

const licence = (overrides = {}) => ({
  id: 11,
  device_id: "FZDEV-COUNTER-1",
  device_name: "Counter 1",
  current_device_name: "Counter 1",
  device_status: "APPROVED",
  entitlement_serial: 7,
  valid_days: 30,
  issued_on: "2026-09-01",
  issued_by_name: "owner",
  ...overrides,
});

const device = (overrides = {}) => ({
  device_id: "FZDEV-COUNTER-1",
  device_name: "Counter 1",
  status: "APPROVED",
  branch_name: "Main Branch",
  counter_name: "Counter 1",
  last_active_at: "2026-09-13T10:00:00.000Z",
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// Faithfulness to Rust. These constants are duplicated from `entitlement.rs` because the Owner's
// machine cannot run it, and a duplicated constant that drifts is worse than no constant at all.
// ---------------------------------------------------------------------------------------------

test("the mirrored entitlement constants still match entitlement.rs", () => {
  const grace = /pub const GRACE_DAYS: i64 = (\d+);/.exec(rustEntitlement);
  assert.ok(grace, "GRACE_DAYS is no longer declared the way this test reads it");
  assert.equal(GRACE_DAYS, Number(grace[1]), "GRACE_DAYS has drifted from entitlement.rs");

  const defaultDays = /pub const DEFAULT_VALID_DAYS: u16 = (\d+);/.exec(rustEntitlement);
  assert.ok(defaultDays, "DEFAULT_VALID_DAYS is no longer declared the way this test reads it");
  assert.equal(DEFAULT_VALID_DAYS, Number(defaultDays[1]));

  // Two ceilings, deliberately different: a licence can physically carry a u16 of days (§4), but
  // the route will not issue a new one for more than ten years.
  assert.equal(WIRE_VALID_DAYS_MAX, 65535);
  assert.equal(VALID_DAYS_MAX, 3650);
  assert.equal(VALID_DAYS_MIN, 1);
});

test("the state boundaries match evaluate_state: strict < on both sides", () => {
  // entitlement.rs:542-548. The expiry day itself is already Grace, not the last Active day --
  // an off-by-one here would tell the Owner a counter is fine on the morning it stops being fine.
  const evaluate = rustEntitlement.slice(rustEntitlement.indexOf("pub fn evaluate_state"));
  assert.match(evaluate, /effective_now < payload\.expires_at_day\(\)/);
  assert.match(evaluate, /effective_now < payload\.grace_until_day\(\)/);

  const issued = "2026-01-01";
  const validDays = 10;
  const expires = deriveExpiryIso({ issued_at: issued, valid_days: validDays });
  assert.equal(expires, "2026-01-11");

  const dayBefore = classifyLicence({ issued_at: issued, valid_days: validDays }, { today: "2026-01-10" });
  assert.equal(dayBefore.status, LICENCE_STATUS.ACTIVE);
  assert.equal(dayBefore.daysRemaining, 1);

  const onExpiry = classifyLicence({ issued_at: issued, valid_days: validDays }, { today: "2026-01-11" });
  assert.equal(onExpiry.status, LICENCE_STATUS.GRACE, "the expiry day is already grace");
  assert.equal(onExpiry.daysRemaining, GRACE_DAYS);

  const lastGraceDay = classifyLicence({ issued_at: issued, valid_days: validDays }, { today: "2026-03-11" });
  assert.equal(lastGraceDay.status, LICENCE_STATUS.GRACE);
  assert.equal(lastGraceDay.daysRemaining, 1);

  const graceOver = classifyLicence({ issued_at: issued, valid_days: validDays }, { today: "2026-03-12" });
  assert.equal(graceOver.status, LICENCE_STATUS.EXPIRED);
});

// ---------------------------------------------------------------------------------------------
// Choosing a validity
// ---------------------------------------------------------------------------------------------

test("the offered validities are the ones the maintainer asked for", () => {
  assert.deepEqual([...VALIDITY_PRESETS], [30, 90, 365]);
});

test("a valid validity is accepted from a number or the string an input gives back", () => {
  assert.deepEqual(validateValidDays(30), { ok: true, validDays: 30 });
  assert.deepEqual(validateValidDays("365"), { ok: true, validDays: 365 });
  assert.deepEqual(validateValidDays(" 90 "), { ok: true, validDays: 90 });
  assert.deepEqual(validateValidDays(VALID_DAYS_MIN), { ok: true, validDays: 1 });
  assert.deepEqual(validateValidDays(VALID_DAYS_MAX), { ok: true, validDays: 3650 });
});

test("an empty custom box asks for a choice rather than reading as zero days", () => {
  // `Number("")` is 0, and 0 days is a licence that is born in its grace period. The empty box
  // must not become that.
  for (const empty of ["", "   ", null, undefined]) {
    const result = validateValidDays(empty);
    assert.equal(result.ok, false, `${JSON.stringify(empty)} was accepted`);
    assert.equal(result.code, "VALID_DAYS_MISSING");
    assert.match(result.message, /Choose how long/);
  }
});

test("each refusal names what is wrong with the number that was given", () => {
  const notANumber = validateValidDays("ninety");
  assert.equal(notANumber.code, "VALID_DAYS_NOT_A_NUMBER");
  assert.match(notANumber.message, /"ninety"/, "the refusal must quote what was typed");

  const fractional = validateValidDays("30.5");
  assert.equal(fractional.code, "VALID_DAYS_NOT_WHOLE");
  assert.match(fractional.message, /30\.5/);

  const zero = validateValidDays(0);
  assert.equal(zero.code, "VALID_DAYS_TOO_SMALL");
  assert.match(zero.message, /grace period the moment it was issued/);

  const negative = validateValidDays(-5);
  assert.equal(negative.code, "VALID_DAYS_TOO_SMALL");
  assert.match(negative.message, /-5/);

  const tooBig = validateValidDays(3651);
  assert.equal(tooBig.code, "VALID_DAYS_TOO_LARGE");
  assert.match(tooBig.message, /3650/);
  assert.match(tooBig.message, /3651/);
  assert.equal(validateValidDays(65535).ok, false, "the wire ceiling is not the issuing ceiling");

  // Every refusal says something. A blank message is a dialog with an OK button and no reason.
  for (const bad of ["", "ninety", "30.5", 0, -5, 3651, 65536, true, [], {}]) {
    const result = validateValidDays(bad);
    assert.equal(result.ok, false, `${JSON.stringify(bad)} was accepted`);
    assert.ok(result.message.trim().length > 10, `${JSON.stringify(bad)} produced no usable message`);
    assert.ok(result.code, `${JSON.stringify(bad)} produced no code`);
  }
});

test("a boolean is not a validity", () => {
  // `Number(true)` is 1, which would silently issue a one-day licence.
  assert.equal(validateValidDays(true).ok, false);
  assert.equal(validateValidDays(false).ok, false);
});

test("describeValidity never renders blank and never says 0", () => {
  assert.equal(describeValidity(1), "1 day");
  assert.equal(describeValidity(30), "30 days");
  assert.equal(describeValidity(365), "365 days (about 1 year)");
  assert.match(describeValidity(730), /730 days \(about 2 years\)/);
  for (const bad of [0, -1, null, undefined, "", "abc", 1.5]) {
    assert.equal(describeValidity(bad), "Not set", `${JSON.stringify(bad)} produced a misleading label`);
  }
});

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

test("a plain date is read as a calendar day, not as UTC midnight", () => {
  assert.equal(dayNumberToIso(toDayNumber("2026-09-14")), "2026-09-14");
  assert.equal(dayNumberToIso(toDayNumber(new Date(2026, 8, 14, 23, 30))), "2026-09-14");
  assert.equal(toDayNumber("not a date"), null);
  assert.equal(toDayNumber(""), null);
  assert.equal(toDayNumber(null), null);
});

test("expiry is issued_at plus valid_days, over month and year ends", () => {
  assert.equal(deriveExpiryIso({ issued_at: "2026-09-14", valid_days: 30 }), "2026-10-14");
  assert.equal(deriveExpiryIso({ issued_at: "2026-12-20", valid_days: 30 }), "2027-01-19");
  assert.equal(deriveExpiryIso({ issued_at: "2028-02-28", valid_days: 1 }), "2028-02-29", "2028 is a leap year");
  assert.equal(deriveExpiryDay({ issued_at: "2026-09-14", valid_days: 0 }), null, "0 days is not issuable");
  assert.equal(deriveExpiryDay({ issued_at: "", valid_days: 30 }), null);
  assert.equal(deriveExpiryDay({ issued_at: "2026-09-14", valid_days: "" }), null, "an absent validity is not zero");
});

test("an unreadable licence is its own answer, never a quiet expiry", () => {
  const nothingToGoOn = classifyLicence({ device_id: "FZDEV-1" }, { today: "2026-09-14" });
  assert.equal(nothingToGoOn.status, LICENCE_STATUS.UNREADABLE);
  assert.equal(nothingToGoOn.expiresOn, null);
  assert.match(nothingToGoOn.detail, /no readable expiry/);

  const noDays = classifyLicence({ issued_on: "2026-09-01" }, { today: "2026-09-14" });
  assert.equal(noDays.status, LICENCE_STATUS.UNREADABLE);

  const absurd = classifyLicence(licence({ valid_days: 999999, expires_on: null, grace_until: null }), { today: "2026-09-14" });
  assert.equal(absurd.status, LICENCE_STATUS.UNREADABLE);

  // A ten-year-plus licence is beyond what the route will issue today but well within what a
  // file can carry, so it must be dated, not called corrupt.
  const long = classifyLicence(
    { issued_on: "2026-09-01", valid_days: 5000 },
    { today: "2026-09-14" },
  );
  assert.equal(long.status, LICENCE_STATUS.ACTIVE);

  const nothing = classifyLicence(null, { today: "2026-09-14" });
  assert.equal(nothing.status, LICENCE_STATUS.UNREADABLE);
  assert.ok(nothing.detail.trim().length > 0);
});

test("a licence that disagrees with itself is named, not silently resolved", () => {
  // Derived expiry and the server's own expires_on are two sources for when a counter stops
  // working. Picking one at random is how a counter dies on a date nobody was shown.
  const conflict = classifyLicence(
    licence({ issued_on: "2026-09-01", valid_days: 30, expires_on: "2027-01-01" }),
    { today: "2026-09-14" },
  );
  assert.equal(conflict.status, LICENCE_STATUS.UNREADABLE);
  assert.match(conflict.detail, /2026-10-01/);
  assert.match(conflict.detail, /2027-01-01/);

  const agreeing = classifyLicence(
    licence({ issued_on: "2026-09-01", valid_days: 30, expires_on: "2026-10-01", grace_until: "2026-11-30" }),
    { today: "2026-09-14" },
  );
  assert.equal(agreeing.status, LICENCE_STATUS.ACTIVE);
  assert.equal(agreeing.expiresOn, "2026-10-01");
});

test("an expired licence reads as expired, not merely as an old date", () => {
  const expired = classifyLicence(licence({ issued_on: "2020-01-01", valid_days: 30 }), { today: "2026-09-14" });
  assert.equal(expired.status, LICENCE_STATUS.EXPIRED);
  assert.equal(expired.label, "Expired");
  assert.match(expired.detail, /Expired on 2020-01-31/);
  assert.match(expired.detail, /Issue a new licence/);
});

// ---------------------------------------------------------------------------------------------
// What each device needs
// ---------------------------------------------------------------------------------------------

test("a device with no licence needs one", () => {
  const row = describeDeviceActivation(device(), [], { today: "2026-09-14" });
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.NEEDS_LICENCE);
  assert.equal(row.label, "Needs a licence");
  assert.equal(row.issuable, true);
  assert.equal(row.latest, null);
  assert.match(row.detail, /No activation licence/);
});

test("a device with a current licence is not offered as awaiting activation", () => {
  const row = describeDeviceActivation(
    device(),
    [licence({ issued_on: "2026-09-01", valid_days: 365 })],
    { today: "2026-09-14" },
  );
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.ACTIVE);
  assert.equal(row.latest.expiresOn, "2027-09-01");
  assert.equal(row.issuable, true, "a working device can still be re-licensed early");
});

test("the newest licence decides the device, not the first one in the list", () => {
  const rows = [
    licence({ entitlement_serial: 1, issued_on: "2024-01-01", valid_days: 30 }),
    licence({ entitlement_serial: 2, issued_on: "2026-09-01", valid_days: 365 }),
  ];
  assert.equal(describeDeviceActivation(device(), rows, { today: "2026-09-14" }).state, DEVICE_ACTIVATION_STATE.ACTIVE);
  assert.equal(
    describeDeviceActivation(device(), [...rows].reverse(), { today: "2026-09-14" }).state,
    DEVICE_ACTIVATION_STATE.ACTIVE,
    "order of the list must not change the verdict",
  );
});

test("a device whose only licence is expired shows as expired", () => {
  const row = describeDeviceActivation(
    device(),
    [licence({ issued_on: "2020-01-01", valid_days: 30 })],
    { today: "2026-09-14" },
  );
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.EXPIRED);
  assert.equal(row.label, "Expired");
});

test("a device in its grace period is neither active nor expired", () => {
  const row = describeDeviceActivation(
    device(),
    [licence({ issued_on: "2026-08-01", valid_days: 30 })],
    { today: "2026-09-14" },
  );
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.GRACE);
  assert.match(row.detail, /keeps working/);
});

test("licences are joined to devices by canonical id, never by coercion", () => {
  // CLAUDE.md: "004" and 4 are different entities, and a mismatch here silently emptied a table.
  const zeroPadded = describeDeviceActivation(
    device({ device_id: "004" }),
    [licence({ device_id: 4, issued_on: "2026-09-01", valid_days: 365 })],
    { today: "2026-09-14" },
  );
  assert.equal(zeroPadded.state, DEVICE_ACTIVATION_STATE.NEEDS_LICENCE, '"004" must not match 4');

  const sameId = describeDeviceActivation(
    device({ device_id: " FZDEV-A " }),
    [licence({ device_id: "FZDEV-A", issued_on: "2026-09-01", valid_days: 365 })],
    { today: "2026-09-14" },
  );
  assert.equal(sameId.state, DEVICE_ACTIVATION_STATE.ACTIVE, "surrounding whitespace is not a different device");

  assert.equal(licencesForDevice([licence()], "FZDEV-COUNTER-1").length, 1);
  assert.equal(licencesForDevice([licence()], "").length, 0, "an empty id must not match everything");
  assert.equal(licencesForDevice(null, "FZDEV-COUNTER-1").length, 0);
  // The dangerous shape: two rows that both have nothing. `String(undefined) === String(undefined)`
  // is true, which would hand one device's licences to another.
  assert.equal(licencesForDevice([{ device_id: undefined }], undefined).length, 0);
  assert.equal(licencesForDevice([{ device_id: null }], null).length, 0);
  assert.equal(licencesForDevice([{ device_id: "" }], "").length, 0);
});

test("a device with no id cannot be issued a licence and says why", () => {
  const row = describeDeviceActivation(device({ device_id: "" }), [], { today: "2026-09-14" });
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.UNREADABLE);
  assert.equal(row.issuable, false);
  assert.match(row.detail, /device ID/i);
});

test("a device whose licences cannot be read is not reported as needing one", () => {
  // "Needs a licence" and "expired" are both guesses when nothing could be dated. Neither is made,
  // and the row says how many records it could not read rather than quoting one of them.
  const row = describeDeviceActivation(
    device(),
    [{ device_id: "FZDEV-COUNTER-1" }, { device_id: "FZDEV-COUNTER-1", valid_days: "soon" }],
    { today: "2026-09-14" },
  );
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.UNREADABLE);
  assert.equal(row.licenceCount, 2);
  assert.match(row.detail, /2 licence records/);
  assert.match(row.detail, /none of them could be read/);
  assert.match(row.detail, /unknown/i);
});

test("one unreadable record does not bury a licence that can be read", () => {
  const row = describeDeviceActivation(
    device(),
    [
      licence({ id: 1, issued_on: "2026-09-01", valid_days: 365 }),
      { id: 2, device_id: "FZDEV-COUNTER-1" },
    ],
    { today: "2026-09-14" },
  );
  assert.equal(row.state, DEVICE_ACTIVATION_STATE.ACTIVE);
  assert.equal(row.latest.expiresOn, "2027-09-01");
});

test("the picker puts the devices awaiting activation first", () => {
  const rows = [
    { state: DEVICE_ACTIVATION_STATE.ACTIVE, deviceName: "Counter 9" },
    { state: DEVICE_ACTIVATION_STATE.NEEDS_LICENCE, deviceName: "Counter 2" },
    { state: DEVICE_ACTIVATION_STATE.EXPIRED, deviceName: "Counter 5" },
    { state: DEVICE_ACTIVATION_STATE.NEEDS_LICENCE, deviceName: "Counter 1" },
  ];
  assert.deepEqual(
    orderDevicesForIssuing(rows).map((row) => row.deviceName),
    ["Counter 1", "Counter 2", "Counter 5", "Counter 9"],
  );
  assert.deepEqual(orderDevicesForIssuing(null), []);
});

// ---------------------------------------------------------------------------------------------
// The whole screen's data, in one pass
// ---------------------------------------------------------------------------------------------

test("a failed licence load never renders as a shop full of unlicensed devices", () => {
  const view = buildActivationIssuingView({
    devices: [device(), device({ device_id: "FZDEV-COUNTER-2" })],
    licences: null,
    licencesError: new Error("Network Error"),
  });
  assert.equal(view.ok, false);
  assert.equal(view.error.code, "LICENCES_UNAVAILABLE");
  assert.match(view.error.message, /Network Error/);
  assert.deepEqual(view.rows, []);
  assert.equal(view.summary.needsLicence, 0, "no count may be published from a failed load");
});

test("a failed device load is its own error, not an empty device list", () => {
  const view = buildActivationIssuingView({ devices: null, licences: [], devicesError: "timeout" });
  assert.equal(view.ok, false);
  assert.equal(view.error.code, "DEVICES_UNAVAILABLE");
  assert.match(view.error.message, /timeout/);
});

test("inputs that have not loaded yet are an error state, not zero devices", () => {
  assert.equal(buildActivationIssuingView({ devices: undefined, licences: [] }).ok, false);
  assert.equal(buildActivationIssuingView({ devices: [], licences: undefined }).ok, false);
  assert.equal(buildActivationIssuingView().ok, false);
});

test("no devices at all is a genuine empty list, and says so with ok", () => {
  const view = buildActivationIssuingView({ devices: [], licences: [] });
  assert.equal(view.ok, true);
  assert.deepEqual(view.rows, []);
  assert.equal(view.summary.total, 0);
});

test("the summary is folded out of the very rows the table renders", () => {
  const view = buildActivationIssuingView({
    devices: [
      device({ device_id: "FZDEV-1", device_name: "Counter 1" }),
      device({ device_id: "FZDEV-2", device_name: "Counter 2" }),
      device({ device_id: "FZDEV-3", device_name: "Counter 3" }),
      device({ device_id: "FZDEV-4", device_name: "Counter 4" }),
      device({ device_id: "", device_name: "Broken" }),
    ],
    licences: [
      licence({ device_id: "FZDEV-2", issued_on: "2026-09-01", valid_days: 365 }),
      licence({ device_id: "FZDEV-3", issued_on: "2026-08-01", valid_days: 30 }),
      licence({ device_id: "FZDEV-4", issued_on: "2020-01-01", valid_days: 30 }),
    ],
    today: "2026-09-14",
  });
  assert.equal(view.ok, true);
  assert.equal(view.summary.total, view.rows.length);
  assert.equal(view.summary.needsLicence, 1);
  assert.equal(view.summary.active, 1);
  assert.equal(view.summary.grace, 1);
  assert.equal(view.summary.expired, 1);
  assert.equal(view.summary.unreadable, 1);

  const recounted = view.rows.reduce((total, row) => ({
    ...total,
    [row.state]: (total[row.state] || 0) + 1,
  }), {});
  assert.equal(view.summary.needsLicence, recounted[DEVICE_ACTIVATION_STATE.NEEDS_LICENCE]);
  assert.equal(view.summary.active, recounted[DEVICE_ACTIVATION_STATE.ACTIVE]);
  assert.equal(view.summary.grace, recounted[DEVICE_ACTIVATION_STATE.GRACE]);
  assert.equal(view.summary.expired, recounted[DEVICE_ACTIVATION_STATE.EXPIRED]);
  assert.equal(view.summary.unreadable, recounted[DEVICE_ACTIVATION_STATE.UNREADABLE]);
  assert.equal(
    view.summary.needsLicence + view.summary.active + view.summary.grace + view.summary.expired + view.summary.unreadable,
    view.summary.total,
    "every row must be counted exactly once",
  );
});

test("the issued history is newest first and carries who issued each one", () => {
  const view = buildActivationIssuingView({
    devices: [device()],
    licences: [
      licence({ id: 1, entitlement_serial: 1, issued_on: "2024-01-01", valid_days: 30 }),
      licence({ id: 2, entitlement_serial: 2, issued_on: "2026-09-01", valid_days: 365 }),
    ],
    today: "2026-09-14",
  });
  assert.deepEqual(view.history.map((entry) => entry.serial), ["2", "1"]);
  assert.equal(view.history[0].classification.status, LICENCE_STATUS.ACTIVE);
  assert.equal(view.history[1].classification.status, LICENCE_STATUS.EXPIRED);
  assert.equal(view.history[0].issuedBy, "owner");
  assert.equal(view.history[0].validDays, 365);
  // An expired licence is visibly expired, not merely an old date in a column.
  assert.equal(view.history[1].classification.label, "Expired");
  assert.deepEqual(view.history.map((entry) => entry.id), ["2", "1"]);
  assert.deepEqual(view.history.map((entry) => entry.downloadable), [true, true]);
});

test("a history row with no id cannot offer its file again", () => {
  // The file comes from GET /licences/:id/file. With no id there is nothing to ask for, and
  // re-issuing instead would burn a serial and supersede the licence already on that machine.
  const view = buildActivationIssuingView({
    devices: [],
    licences: [licence({ id: null })],
    today: "2026-09-14",
  });
  assert.equal(view.history[0].id, "");
  assert.equal(view.history[0].downloadable, false);
});

test("the history distinguishes the name on the file from the device as it is today", () => {
  const view = buildActivationIssuingView({
    devices: [],
    licences: [
      licence({ id: 1, device_name: "Counter 1", current_device_name: "Front Till", device_status: "APPROVED" }),
      licence({ id: 2, device_id: "FZDEV-GONE", device_name: "Old Counter", current_device_name: null, device_status: null }),
    ],
    today: "2026-09-14",
  });
  const renamed = view.history.find((entry) => entry.id === "1");
  assert.equal(renamed.deviceName, "Counter 1", "the name on the file is what was issued");
  assert.equal(renamed.currentDeviceName, "Front Till");
  assert.equal(renamed.renamedSince, true);
  assert.equal(renamed.deviceRetired, false);

  const retired = view.history.find((entry) => entry.id === "2");
  assert.equal(retired.deviceRetired, true, "a device that is gone from the device table must show as retired");
  assert.equal(retired.renamedSince, false);
});

test("the serial and the issuer are read under either name the routes use", () => {
  const view = buildActivationIssuingView({
    devices: [],
    licences: [{ id: 3, device_id: "FZDEV-1", serial: 9, issued_by_username: "owner", issued_at: "2026-09-01", valid_days: 30 }],
    today: "2026-09-14",
  });
  assert.equal(view.history[0].serial, "9");
  assert.equal(view.history[0].issuedBy, "owner");
  assert.equal(view.history[0].classification.expiresOn, "2026-10-01", "issued_at alone is enough to date a licence");
});

test("a licence with only the server's dates is still classified", () => {
  // The list carries no status field on purpose: expires_on and grace_until are the definition,
  // and this module is the only place that turns them into a word.
  const view = buildActivationIssuingView({
    devices: [device()],
    licences: [{ id: 4, device_id: "FZDEV-COUNTER-1", expires_on: "2026-10-01", grace_until: "2026-11-30" }],
    today: "2026-09-14",
  });
  assert.equal(view.history[0].classification.status, LICENCE_STATUS.ACTIVE);
  assert.equal(view.rows[0].state, DEVICE_ACTIVATION_STATE.ACTIVE);
  assert.equal(view.history[0].validDays, null, "an absent validity is not zero days");
  assert.equal(describeValidity(view.history[0].validDays), "Not set");
});

test("a grace_until that is not expiry plus 60 days is a disagreement, not a new rule", () => {
  const wrong = classifyLicence(
    { issued_on: "2026-09-01", valid_days: 30, grace_until: "2026-12-31" },
    { today: "2026-09-14" },
  );
  assert.equal(wrong.status, LICENCE_STATUS.UNREADABLE);
  assert.match(wrong.detail, /2026-11-30/);
  assert.match(wrong.detail, /2026-12-31/);

  const right = classifyLicence(
    { issued_on: "2026-09-01", valid_days: 30, grace_until: "2026-11-30" },
    { today: "2026-09-14" },
  );
  assert.equal(right.status, LICENCE_STATUS.ACTIVE);
  assert.equal(right.graceUntil, "2026-11-30");
});

test("history rows without an issuer say so rather than rendering blank", () => {
  const view = buildActivationIssuingView({
    devices: [],
    licences: [licence({ issued_by_name: "", device_name: "", current_device_name: "", device_status: "" })],
    today: "2026-09-14",
  });
  assert.equal(view.history[0].issuedBy, "Not recorded");
  assert.equal(view.history[0].deviceName, "FZDEV-COUNTER-1", "falls back to the id, never to empty");
});

// ---------------------------------------------------------------------------------------------
// Issuing, and what comes back
// ---------------------------------------------------------------------------------------------

test("the request body carries the picked id unchanged and a validated validity", () => {
  const request = buildIssueRequest({ deviceId: "FZDEV-COUNTER-1", validDays: "90" });
  assert.deepEqual(request, { ok: true, body: { device_id: "FZDEV-COUNTER-1", valid_days: 90 } });
  assert.equal(typeof request.body.valid_days, "number", "the route expects a number, not a form string");
});

test("nothing is requested without a device or with a bad validity", () => {
  const noDevice = buildIssueRequest({ deviceId: "", validDays: 30 });
  assert.equal(noDevice.ok, false);
  assert.equal(noDevice.code, "NO_DEVICE_SELECTED");
  assert.match(noDevice.message, /Pick the device/);

  const badDays = buildIssueRequest({ deviceId: "FZDEV-1", validDays: 0 });
  assert.equal(badDays.ok, false);
  assert.equal(badDays.code, "VALID_DAYS_TOO_SMALL");

  assert.equal(buildIssueRequest().ok, false);
});

test("every refusal the route can answer with has words of its own", () => {
  const notOwner = describeIssueFailure({ code: "NOT_OWNER", message: "forbidden" });
  assert.match(notOwner, /Only the Owner/);

  const noDevice = describeIssueFailure({ code: "NO_SUCH_DEVICE" });
  assert.match(noDevice, /register itself/);

  const badDays = describeIssueFailure({ code: "INVALID_VALID_DAYS", message: "valid_days must be 1..65535" });
  assert.match(badDays, /65535/);

  const noKey = describeIssueFailure({ code: "SIGNING_KEY_UNAVAILABLE" });
  assert.match(noKey, /signing key/);
  assert.match(noKey, /nothing was changed/i);

  // An unknown code still has to say a licence was not issued.
  const unknown = describeIssueFailure({ code: "TEAPOT", message: "", status: 418 });
  assert.match(unknown, /No licence was issued/);
  assert.match(unknown, /418/);
  assert.match(describeIssueFailure(), /No licence was issued/);
  for (const code of ["NOT_OWNER", "NO_SUCH_DEVICE", "INVALID_VALID_DAYS", "SIGNING_KEY_UNAVAILABLE", "", "WHATEVER"]) {
    assert.ok(describeIssueFailure({ code }).trim().length > 20, `${code} produced no usable sentence`);
  }
});

test("a success that carries no usable file is refused before it is offered", () => {
  const good = [
    "# FroozERP activation file.",
    "# device: FZDEV-COUNTER-1",
    `format: ${LIC_CONTAINER_FORMAT}`,
    "payload: AQIDBA==",
    "signature: BQYHCA==",
    "",
  ].join("\n");
  assert.deepEqual(validateLicenceArtifact(good), { ok: true });

  for (const [artifact, code] of [
    ["", "EMPTY_LICENCE"],
    ["   ", "EMPTY_LICENCE"],
    [null, "EMPTY_LICENCE"],
    [undefined, "EMPTY_LICENCE"],
    [{ lic: "x" }, "EMPTY_LICENCE"],
    ["format: FRZ-LIC/2\npayload: AA==\nsignature: BB==", "UNKNOWN_LICENCE_FORMAT"],
    [`format: ${LIC_CONTAINER_FORMAT}\nsignature: BB==`, "MALFORMED_LICENCE"],
    [`format: ${LIC_CONTAINER_FORMAT}\npayload: AA==`, "MALFORMED_LICENCE"],
    [`format: ${LIC_CONTAINER_FORMAT}\npayload:\nsignature: BB==`, "MALFORMED_LICENCE"],
  ]) {
    const result = validateLicenceArtifact(artifact);
    assert.equal(result.ok, false, `${JSON.stringify(artifact)} was accepted as a licence`);
    assert.equal(result.code, code, `${JSON.stringify(artifact)} got the wrong code`);
    assert.ok(result.message.includes("has not been offered for saving") || result.message.includes("nothing to save"));
  }
});

test("a comment line containing a colon does not masquerade as a field", () => {
  // The `.lic` header is unsigned support metadata and may contain ':' (activation.rs).
  const disguised = [
    "# format: FRZ-LIC/9",
    `format: ${LIC_CONTAINER_FORMAT}`,
    "payload: AQID",
    "signature: BAUG",
  ].join("\n");
  assert.deepEqual(validateLicenceArtifact(disguised), { ok: true });
});

test("the file is named after the device and never collapses to a bare extension", () => {
  assert.equal(
    licenceFileName({ deviceName: "Counter 1", deviceId: "FZDEV-A", serial: 7 }),
    "froozerp-activation-counter-1-7.lic",
  );
  assert.equal(licenceFileName({ deviceName: "", deviceId: "FZDEV-A", serial: "" }), "froozerp-activation-fzdev-a.lic");
  assert.equal(licenceFileName({}), "froozerp-activation-device.lic");
  assert.equal(licenceFileName({ deviceName: "///" }), "froozerp-activation-device.lic");
  for (const name of [licenceFileName({}), licenceFileName({ deviceName: "Counter 1" })]) {
    assert.ok(name.endsWith(".lic"));
    assert.ok(!/[\\/:*?"<>|]/.test(name), `${name} is not a safe Windows file name`);
  }
});

test("the codes only the final contract has are named too", () => {
  assert.match(describeIssueFailure({ code: "INVALID_DEVICE_ID" }), /device ID/i);
  assert.match(describeIssueFailure({ code: "TRUSTED_KEYS_UNAVAILABLE" }), /Nothing was issued/i);
  assert.match(describeIssueFailure({ code: "ISSUE_FAILED" }), /no licence was created/i);
  assert.match(describeLicenceFileFailure({ code: "NO_SUCH_LICENCE" }), /Issue a new licence/);
  assert.match(describeLicenceFileFailure({ code: "INVALID_LICENCE_ID" }), /could not be identified/);
});

test("an unrecognised code shows the server's own message verbatim", () => {
  const message = "company scope mismatch for device FZDEV-9";
  const issue = describeIssueFailure({ code: "SOMETHING_NEW", message, status: 409 });
  assert.ok(issue.includes(message), "the server's message must survive intact");
  assert.match(issue, /No licence was issued/);
  assert.match(issue, /409/);

  // A failed *read* must not claim an issue was attempted.
  const file = describeLicenceFileFailure({ code: "SOMETHING_NEW", message, status: 409 });
  assert.ok(file.includes(message));
  assert.match(file, /could not be fetched/);
  assert.doesNotMatch(file, /No licence was issued/);
});

test("a licence that comes back is turned into a file name, a sentence and a verdict", () => {
  const response = {
    lic: `format: ${LIC_CONTAINER_FORMAT}\npayload: AQID\nsignature: BAUG\n`,
    device_id: "FZDEV-COUNTER-1",
    device_name: "Counter 1",
    serial: 7,
    valid_days: 365,
    issued_at: "2026-09-14",
    issued_on: "2026-09-14",
    expires_on: "2027-09-14",
    grace_until: "2027-11-13",
  };
  const described = describeIssuedLicence(response, { today: "2026-09-14" });
  assert.equal(described.ok, true);
  assert.equal(described.fileName, "froozerp-activation-counter-1-7.lic");
  assert.equal(described.classification.status, LICENCE_STATUS.ACTIVE);
  assert.match(described.detail, /Counter 1/);
  assert.match(described.detail, /365 days/);
  assert.match(described.detail, /2027-09-14/);
  assert.equal(described.lic, response.lic);
});

test("a licence that comes back without a usable file is refused, not shown as issued", () => {
  const refused = describeIssuedLicence({ device_id: "FZDEV-1", lic: "" }, { today: "2026-09-14" });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, "EMPTY_LICENCE");
  assert.match(refused.message, /nothing to save/);
  assert.equal(refused.lic, undefined, "there must be no file to offer");
});

test("a response that names no device still says who the licence is for", () => {
  const described = describeIssuedLicence(
    { lic: `format: ${LIC_CONTAINER_FORMAT}\npayload: AQID\nsignature: BAUG`, valid_days: 30, issued_on: "2026-09-14" },
    { today: "2026-09-14", fallbackDeviceId: "FZDEV-COUNTER-2", fallbackDeviceName: "Counter 2" },
  );
  assert.equal(described.ok, true);
  assert.equal(described.deviceName, "Counter 2");
  assert.equal(described.deviceId, "FZDEV-COUNTER-2");
  assert.match(described.fileName, /^froozerp-activation-counter-2\.lic$/);
  assert.ok(described.detail.trim().length > 20);
});

// ---------------------------------------------------------------------------------------------
// The rules that can only live in App.jsx
// ---------------------------------------------------------------------------------------------

const sectionSource = (() => {
  const start = appSource.indexOf("function DeviceActivationIssuingSection(");
  assert.ok(start > 0, "the activation issuing section is missing from App.jsx");
  const end = appSource.indexOf("\nfunction ", start + 1);
  return appSource.slice(start, end > start ? end : appSource.length);
})();

test("the section is Owner-only, and Admin is not enough", () => {
  // Issuing a licence is what admits a machine to the business. An Admin may approve a device;
  // only the Owner may license one.
  //
  // The section is declared once, in the shared registry, carrying `ownerOnly`. The registry has
  // no idea who is signed in, so App.jsx does the filtering -- but there is still only one place
  // the section is defined, which is what stops the page and the drill-down disagreeing about
  // whether it exists.
  const registration = appSource.slice(
    appSource.indexOf("const isOwnerAccount"),
    appSource.indexOf("const sectionContent = {"),
  );
  assert.ok(registration.length > 0, "the Owner-only section registration is missing");
  assert.match(registration, /=== "OWNER"/);
  assert.doesNotMatch(registration, /ADMIN/i, "Admin must not reach the issuing screen");
  assert.match(registration, /section\.ownerOnly \|\| isOwnerAccount/);

  const registryEntry = navigationRegistry
    .find((item) => item.id === "settings")
    .sections.find((section) => section.id === "settings/device-activation");
  assert.ok(registryEntry, "the section must be in the shared registry, not a second list");
  assert.equal(registryEntry.ownerOnly, true, "without the flag the card shows to every role");

  const mount = appSource.slice(appSource.indexOf('"settings/device-activation": ('), appSource.indexOf('"settings/updates": ('));
  assert.match(mount, /canIssue=\{isOwnerAccount\}/);
  assert.match(sectionSource, /if \(!canIssue\)/, "the component must refuse on its own too");
});

test("the group card's count and the group's contents come from one list", () => {
  // Summary vs detail, in the navigation: a card saying "6 settings" that opens onto 5 is the
  // same failure as a tile that disagrees with its table.
  const helper = appSource.slice(appSource.indexOf("const sectionsInGroup"), appSource.indexOf("const sectionContent = {"));
  assert.match(helper, /visibleSettingsSections\.filter/, "one filtered list feeds both the count and the contents");
  assert.match(appSource, /const count = sectionsInGroup\(group\.id\)\.length/, "the count must use that same list");
});

test("the screen never asks anybody to type or read out a device id", () => {
  // The entire point of the work: devices register themselves and the Owner picks one.
  assert.doesNotMatch(sectionSource, /Read this Device ID/);
  assert.doesNotMatch(appSource, /Read this Device ID to the owner/, "the phone call is what this replaced");
  assert.doesNotMatch(sectionSource, /onChange=\{\(event\) => setSelectedDeviceId\(event\.target\.value\)\}/, "the device is picked, not typed");
  assert.match(sectionSource, /type="radio"/, "devices are picked from the list");
  assert.match(sectionSource, /readOnly value=\{selectedRow/, "the selected device is shown, not entered");
});

test("the screen's tiles and tables all come from one buildActivationIssuingView call", () => {
  assert.equal((sectionSource.match(/buildActivationIssuingView\(/g) || []).length, 1);
  assert.match(sectionSource, /view\.summary\.needsLicence/);
  assert.match(sectionSource, /orderDevicesForIssuing\(view\.rows\)/);
  assert.match(sectionSource, /view\.history\.map/);
});

test("a view that failed to build renders an error, not an empty table", () => {
  const guard = sectionSource.slice(sectionSource.indexOf("{!view.ok ?"), sectionSource.indexOf("purchase-summary-grid"));
  assert.ok(guard.length > 0, "the failed-view branch is missing");
  assert.match(guard, /view\.error\.message/);
  assert.match(guard, /role="alert"/);
});

test("the issued file is validated before it is offered for saving", () => {
  // `describeIssuedLicence` refuses an empty or malformed `.lic`, and the screen must act on that
  // refusal rather than setting an "issued" panel over a file that would fail on the counter.
  const check = sectionSource.slice(sectionSource.indexOf("const described = describeIssuedLicence"));
  assert.ok(check.length > 0, "the issue path must go through describeIssuedLicence");
  assert.match(check.slice(0, 400), /if \(!described\.ok\)[\s\S]*?setOutcome\(\{ tone: "error"[\s\S]*?return;/);
});

test("an existing licence's file is fetched again rather than re-issued", () => {
  // A re-issue burns a serial and supersedes the licence already on that machine. Somebody who
  // mislaid a file must not silently change a working counter.
  const again = sectionSource.slice(sectionSource.indexOf("const downloadAgain"), sectionSource.indexOf("// How the .lic reaches the disk"));
  assert.ok(again.length > 0, "the download-again path is missing");
  assert.match(again, /axios\.get\(`\$\{API_URL\}\/api\/activation\/licences\/\$\{encodeURIComponent\(entry\.id\)\}\/file`\)/);
  assert.doesNotMatch(again, /axios\.post/, "fetching a file again must never post a new issue");
  assert.match(again, /describeLicenceFileFailure/);
  assert.match(sectionSource, /onClick=\{\(\) => downloadAgain\(entry\)\}/);
  assert.match(sectionSource, /disabled=\{issuing \|\| !entry\.downloadable\}/);
});

test("both ways of getting the .lic onto the device are present", () => {
  // The shell has no general-purpose save dialog, so the save is a webview download following
  // the app's existing catalogue export, and copy is a first-class alternative rather than a
  // fallback nobody can reach -- the container is plain text by design.
  assert.match(sectionSource, /link\.download = issued\.fileName/);
  assert.match(sectionSource, /navigator\.clipboard\.writeText\(issued\.lic\)/);
  assert.match(sectionSource, /<textarea[\s\S]*?value=\{issued\.lic\}/, "the file text must be visible even if both buttons fail");
  assert.match(sectionSource, /The file could not be saved/, "a save that did not happen must not be reported as one");
});

test("the route contract the screen calls is the one that was agreed", () => {
  assert.match(sectionSource, /axios\.post\(`\$\{API_URL\}\/api\/activation\/licences`/);
  assert.match(sectionSource, /axios\.get\(`\$\{API_URL\}\/api\/activation\/licences`\)/);
  assert.match(sectionSource, /response\.data\?\.licences/);
});

test("a 200 with no licence list is not read as an empty list", () => {
  const load = sectionSource.slice(sectionSource.indexOf("const loadLicences"), sectionSource.indexOf("useEffect(() => { loadLicences"));
  assert.match(load, /if \(!Array\.isArray\(rows\)\)/);
  assert.match(load, /setLicencesError/);
});

test("the activation gate points at the new screen instead of a phone call", () => {
  const gate = appSource.slice(appSource.indexOf("function ActivationGate("), appSource.indexOf("function DeviceActivationIssuingSection("));
  assert.match(gate, /Device Activation Licences/, "the gate must name where the Owner issues it");
});

test("a saved licence says where it landed, not only what it is called", () => {
  // Found rehearsing 1.0.73 on 2026-09-19: the save worked and the Owner's next words were "pata
  // nahi kahan" -- it saved, but nowhere. The shell has no save dialog, so the webview drops the
  // file in the browser's download folder and the screen is the only thing that could say so. On
  // the one screen whose entire purpose is producing a file to carry to a counter, a confirmation
  // that names the file but not the folder sends the reader hunting for what they were just told
  // was saved.
  const save = sectionSource.slice(sectionSource.indexOf("const saveLicenceFile"), sectionSource.indexOf("const copyLicence"));
  const success = save.slice(save.indexOf('tone: "ok"'));
  assert.match(success, /Downloads folder/, "the success message must name where the file went");
  assert.match(success, /\$\{issued\.fileName\}/, "and still name the file, so it can be found by name");
});

// Two devices answering to the same name, seen on a real device list on 2026-09-19: a counter
// rebuilt and registered again leaves two rows both called "DELL - FroozERP", same branch, both
// awaiting a licence. The release process requires that nobody has to read out an FZDEV id, and
// with identical names the id is the only thing left to read -- so a licence goes to whichever
// machine the Owner guessed, and fails at the counter rather than here.

test("devices sharing a name are told apart by something a person already knows", () => {
  const rows = markAmbiguousDeviceNames([
    { deviceName: "DELL - FroozERP", counterName: "", lastActiveAt: "2026-09-19T13:52:48Z" },
    { deviceName: "DELL - FroozERP", counterName: "", lastActiveAt: "2026-06-19T11:31:53Z" },
    { deviceName: "Phase 1 Verification Browser", counterName: "", lastActiveAt: "2026-07-10T12:52:05Z" },
  ]);

  assert.equal(rows[0].nameIsAmbiguous, true);
  assert.equal(rows[1].nameIsAmbiguous, true);
  assert.deepEqual(rows[0].nameDistinction, { kind: "lastSeen", value: "2026-09-19T13:52:48Z" });
  assert.deepEqual(rows[1].nameDistinction, { kind: "lastSeen", value: "2026-06-19T11:31:53Z" });

  // The device whose name is already unique is left alone. Marking every row would make the
  // marking meaningless and add noise to the rows that were never in doubt.
  assert.equal(rows[2].nameIsAmbiguous, false);
  assert.equal(rows[2].nameDistinction, null);
});

test("a counter name is preferred over a timestamp, and only when it discriminates", () => {
  const distinct = markAmbiguousDeviceNames([
    { deviceName: "Counter PC", counterName: "Till 1", lastActiveAt: "2026-09-19T13:52:48Z" },
    { deviceName: "Counter PC", counterName: "Till 2", lastActiveAt: "2026-09-19T13:52:48Z" },
  ]);
  assert.deepEqual(distinct[0].nameDistinction, { kind: "counter", value: "Till 1" });

  // A counter both of them share separates nothing. Offering it would read as an answer to
  // "which one is this?" while leaving the reader exactly where they started.
  const shared = markAmbiguousDeviceNames([
    { deviceName: "Counter PC", counterName: "Till 1", lastActiveAt: "2026-09-19T13:52:48Z" },
    { deviceName: "Counter PC", counterName: "Till 1", lastActiveAt: "2026-06-19T11:31:53Z" },
  ]);
  assert.deepEqual(shared[0].nameDistinction, { kind: "lastSeen", value: "2026-09-19T13:52:48Z" });
});

test("when nothing separates two rows, no distinction is invented", () => {
  const rows = markAmbiguousDeviceNames([
    { deviceName: "Counter PC", counterName: "Till 1", lastActiveAt: "2026-09-19T13:52:48Z" },
    { deviceName: "Counter PC", counterName: "Till 1", lastActiveAt: "2026-09-19T13:52:48Z" },
  ]);
  assert.equal(rows[0].nameIsAmbiguous, true, "the reader still has to be told the name is not unique");
  assert.equal(rows[0].nameDistinction, null, "but a label that does not discriminate is worse than none");
});

test("the view marks ambiguity, so every screen reading rows gets it", () => {
  const view = buildActivationIssuingView({
    devices: [
      { device_id: "FZDEV-A", device_name: "DELL - FroozERP", last_active_at: "2026-09-19T13:52:48Z" },
      { device_id: "FZDEV-B", device_name: "DELL - FroozERP", last_active_at: "2026-06-19T11:31:53Z" },
    ],
    licences: [],
    today: "2026-09-19",
  });
  assert.equal(view.ok, true);
  assert.equal(view.rows.every((row) => row.nameIsAmbiguous), true);
});

test("the screen shows the distinction, not only the id", () => {
  const cell = sectionSource.slice(sectionSource.indexOf('<td className="primary-cell">'));
  const nameCell = cell.slice(0, cell.indexOf("</td>"));
  assert.match(nameCell, /row\.nameIsAmbiguous/, "the name cell must react to a shared name");
  assert.match(nameCell, /Last seen /, "and date a device the reader can place in time");
  assert.match(nameCell, /row\.deviceId/, "the id stays: this decides what has to be read, not what is shown");
});
