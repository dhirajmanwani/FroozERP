/**
 * Issuing a device activation licence, decided here rather than in the screen.
 *
 * The Owner has to be able to bring a new counter online himself, from whatever machine he
 * happens to be at, without a command line and without reading a `FZDEV-…` id down the phone.
 * `App.jsx` renders that; this module makes every decision inside it, because this is the half
 * that can be tested (`activationIssuing.test.mjs`) and `App.jsx` is not.
 *
 * What is decided here:
 *   - whether a chosen validity is a validity at all, and if not, what is wrong with it
 *   - when a licence expires, and whether it is Active, in Grace, or Expired *today*
 *   - what each registered device needs: a licence, nothing, or a replacement
 *   - whether what the server handed back is actually a licence file worth saving
 *
 * Deliberately NOT decided here: authority. Only the Owner may issue, and all three routes
 * (`POST /api/activation/licences`, `GET /api/activation/licences`,
 * `GET /api/activation/licences/:id/file`) answer `NOT_OWNER` to anyone else. The screen hides
 * itself from non-Owners as a courtesy; hiding a button is not a permission check.
 *
 * ## Where the status comes from
 *
 * The licence list carries no status field on purpose: the signed dates already define
 * live/grace/expired, so deriving it in one place — `classifyLicence` — keeps that the only
 * definition. Two places that both decide whether a counter still works is how they come to
 * disagree.
 *
 * ## Faithfulness to Rust
 *
 * `src-tauri/src/entitlement.rs` is authoritative for what a licence *means* on the device that
 * redeems it. Two things are mirrored from it and must not drift:
 *
 *   - `GRACE_DAYS = 60` (entitlement.rs:34)
 *   - the boundaries in `evaluate_state` (entitlement.rs:542-548): `now < expires` is Active,
 *     `now < expires + GRACE_DAYS` is Grace, otherwise Expired. Note both are strict `<`, so the
 *     expiry day itself is already Grace, not the last Active day.
 *
 * This module is a *preview* of that verdict for the Owner's benefit. The device still decides
 * its own state from the signed bytes; nothing here is policy.
 *
 * ## The pitfalls in CLAUDE.md, and where each one is answered
 *
 *   - "Errors must never render as zero." `buildActivationIssuingView` refuses to produce rows
 *     at all when either input failed to load. A device list with no licence list would show
 *     every counter as "needs a licence", which is a confident lie built out of a failed fetch.
 *   - "Summary vs detail must share filter semantics." The summary counts are folded from the
 *     very rows the table renders, not recomputed from the inputs.
 *   - "`??` does not fall through on `0`." A validity of `0` is a real, wrong answer that must be
 *     named, and `daysRemaining` of `0` is a real day. Every numeric read goes through
 *     `finiteNumber`, which returns `null` only for genuinely absent or unparseable values.
 *   - "Canonical IDs." Device ids are opaque strings. Licences are joined to devices with
 *     `inventoryIdsEqual`, never `String(...)` on one side and a coercion on the other.
 */

import { canonicalInventoryId, inventoryIdsEqual } from "./stockInventory.js";

/** Mirrors `GRACE_DAYS` in src-tauri/src/entitlement.rs. */
export const GRACE_DAYS = 60;

/**
 * What the Owner may choose, and what a licence can physically carry — two different numbers.
 *
 * `valid_days` is a u16 on the wire (docs/offline-activation-design.md §4), so an *existing*
 * licence may legitimately record anything up to 65535 days and must still be classified rather
 * than called corrupt. New licences are capped much lower by the route, at ten years, because a
 * validity nobody will outlive is a licence nobody will ever re-check.
 *
 * Zero is excluded from both: a licence valid for zero days is already in its grace period the
 * moment it is signed.
 */
export const VALID_DAYS_MIN = 1;
export const VALID_DAYS_MAX = 3650;
export const WIRE_VALID_DAYS_MAX = 65535;

/** `DEFAULT_VALID_DAYS` in entitlement.rs. What the screen offers first. */
export const DEFAULT_VALID_DAYS = 365;

/** The buttons, in the order they are shown. A custom box covers everything else. */
export const VALIDITY_PRESETS = Object.freeze([30, 90, 365]);

/** How a single licence stands today. */
export const LICENCE_STATUS = Object.freeze({
  ACTIVE: "active",
  GRACE: "grace",
  EXPIRED: "expired",
  /** The licence record could not be read, or contradicts itself. Never silently an "expired". */
  UNREADABLE: "unreadable",
});

/** What the screen says about a device. */
export const DEVICE_ACTIVATION_STATE = Object.freeze({
  NEEDS_LICENCE: "needs-licence",
  ACTIVE: "active",
  GRACE: "grace",
  EXPIRED: "expired",
  UNREADABLE: "unreadable",
});

const MS_PER_DAY = 86400000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

const text = (value) => (value === null || value === undefined ? "" : String(value).trim());

/** The first of several fields that actually carries something. Never returns `undefined`. */
const firstText = (...values) => {
  for (const value of values) {
    const found = text(value);
    if (found !== "") return found;
  }
  return "";
};

/**
 * A number, or `null` when there genuinely is not one.
 *
 * `Number("")` is `0` and `Number(null)` is `0`, either of which would turn "the server sent no
 * validity" into "the validity is zero days". Booleans are refused for the same reason.
 */
const finiteNumber = (value) => {
  if (value === null || value === undefined || typeof value === "boolean") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const raw = text(value);
  if (raw === "") return null;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * A calendar day index for a date, or `null`.
 *
 * Calendar, not clock: a plain `YYYY-MM-DD` is read field by field rather than through
 * `new Date(...)`, which would interpret it as UTC midnight and land on the previous day in any
 * negative offset. A full timestamp is read in the viewer's own calendar, because "today" for
 * the shop is the day on the wall, not the day in UTC.
 */
export const toDayNumber = (value) => {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? null
      : Math.round(Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) / MS_PER_DAY);
  }
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : null;
  const raw = text(value);
  if (raw === "") return null;
  const plain = ISO_DATE.exec(raw);
  if (plain) {
    const [, year, month, day] = plain;
    return Math.round(Date.UTC(Number(year), Number(month) - 1, Number(day)) / MS_PER_DAY);
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(" ", "T") : raw;
  const parsed = new Date(normalized);
  if (Number.isNaN(parsed.getTime())) return null;
  return Math.round(
    Date.UTC(parsed.getFullYear(), parsed.getMonth(), parsed.getDate()) / MS_PER_DAY,
  );
};

/** The inverse of `toDayNumber`, as `YYYY-MM-DD`. `null` in, `null` out. */
export const dayNumberToIso = (day) => {
  const value = finiteNumber(day);
  if (value === null) return null;
  const date = new Date(Math.trunc(value) * MS_PER_DAY);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
};

/**
 * A validity the Owner typed or picked, judged.
 *
 * Every refusal names what is wrong with the number he actually gave, not what the rule is in
 * the abstract: "365.5 is not a whole number of days" is actionable, "invalid input" is not.
 */
export const validateValidDays = (input) => {
  const supplied = text(input);
  if (supplied === "" && typeof input !== "number") {
    return {
      ok: false,
      code: "VALID_DAYS_MISSING",
      message: "Choose how long this activation should last before issuing it.",
    };
  }
  const parsed = finiteNumber(input);
  if (parsed === null) {
    return {
      ok: false,
      code: "VALID_DAYS_NOT_A_NUMBER",
      message: `A validity must be a number of days. "${supplied}" is not a number.`,
    };
  }
  if (!Number.isInteger(parsed)) {
    return {
      ok: false,
      code: "VALID_DAYS_NOT_WHOLE",
      message: `A validity must be a whole number of days. ${parsed} is not.`,
    };
  }
  if (parsed < VALID_DAYS_MIN) {
    return {
      ok: false,
      code: "VALID_DAYS_TOO_SMALL",
      message: parsed === 0
        ? "A validity of 0 days would put the activation into its grace period the moment it was issued. Use at least 1 day."
        : `A validity cannot be negative. ${parsed} is less than the minimum of ${VALID_DAYS_MIN} day.`,
    };
  }
  if (parsed > VALID_DAYS_MAX) {
    return {
      ok: false,
      code: "VALID_DAYS_TOO_LARGE",
      message: `A new activation can last at most ${VALID_DAYS_MAX} days (ten years). ${parsed} is more than that.`,
    };
  }
  return { ok: true, validDays: parsed };
};

/** "1 day" / "30 days" / "365 days (about 1 year)". Never blank, never bare. */
export const describeValidity = (days) => {
  const value = finiteNumber(days);
  if (value === null || !Number.isInteger(value) || value < VALID_DAYS_MIN) return "Not set";
  const plural = `${value} ${value === 1 ? "day" : "days"}`;
  if (value < 365) return plural;
  const years = Math.round((value / 365) * 10) / 10;
  return `${plural} (about ${years} ${years === 1 ? "year" : "years"})`;
};

/** The issue date a licence record carries, under either of the two names the route uses. */
const issuedDayOf = (row) => toDayNumber(firstText(row.issued_on, row.issued_at));

/**
 * When a licence expires, from the two fields that decide it.
 *
 * Expiry is *derived* rather than taken from whatever `expires_on` the server happened to send,
 * so that the two can be compared — see `classifyLicence`, where a disagreement between them is
 * a named state rather than a coin toss.
 */
export const deriveExpiryDay = ({ issued_at: issuedAt, issued_on: issuedOn, valid_days: validDays } = {}) => {
  const issuedDay = toDayNumber(firstText(issuedOn, issuedAt));
  const days = finiteNumber(validDays);
  if (issuedDay === null || days === null || !Number.isInteger(days)) return null;
  if (days < VALID_DAYS_MIN || days > WIRE_VALID_DAYS_MAX) return null;
  return issuedDay + days;
};

/** The same, as `YYYY-MM-DD`. */
export const deriveExpiryIso = (licence) => dayNumberToIso(deriveExpiryDay(licence));

const unreadable = (detail, extra = {}) => ({
  status: LICENCE_STATUS.UNREADABLE,
  issuedOn: null,
  expiresOn: null,
  graceUntil: null,
  daysRemaining: null,
  label: "Cannot be read",
  detail,
  ...extra,
});

/**
 * Where a licence stands today: Active, in Grace, Expired — or unreadable, which is its own
 * answer and never quietly folded into "expired".
 *
 * Mirrors `evaluate_state` in entitlement.rs, minus the clock-anomaly arm: that one needs the
 * device's own high-water mark, which the Owner's machine does not have. This is the Owner's
 * preview, not the device's verdict.
 *
 * The route sends `issued_on` + `valid_days` *and* `expires_on` + `grace_until`, all four out of
 * the same signed payload. They are cross-checked rather than one being picked: two sources that
 * disagree about when a counter stops working is exactly the internal inconsistency CLAUDE.md
 * says must surface as its own state.
 */
export const classifyLicence = (licence, { today } = {}) => {
  const row = licence && typeof licence === "object" ? licence : {};
  const todayDay = toDayNumber(today === undefined ? new Date() : today);
  if (todayDay === null) {
    return unreadable("Today's date could not be read, so this licence cannot be dated.");
  }

  const issuedDay = issuedDayOf(row);
  const issuedOn = dayNumberToIso(issuedDay);
  const days = finiteNumber(row.valid_days);
  const validityIsUsable = days !== null && Number.isInteger(days)
    && days >= VALID_DAYS_MIN && days <= WIRE_VALID_DAYS_MAX;
  if (days !== null && !validityIsUsable) {
    return unreadable(
      `This licence records a validity of ${days} days, which is outside the ${VALID_DAYS_MIN}-${WIRE_VALID_DAYS_MAX} days an activation file can carry.`,
      { issuedOn },
    );
  }

  const derivedExpiry = issuedDay !== null && validityIsUsable ? issuedDay + days : null;
  const reportedExpiry = toDayNumber(row.expires_on);
  if (derivedExpiry !== null && reportedExpiry !== null && derivedExpiry !== reportedExpiry) {
    return unreadable(
      `This licence disagrees with itself: issued ${issuedOn} for ${days} days expires on ${dayNumberToIso(derivedExpiry)}, but it records ${dayNumberToIso(reportedExpiry)}. It has not been dated here.`,
      { issuedOn },
    );
  }
  const expiresDay = derivedExpiry === null ? reportedExpiry : derivedExpiry;
  if (expiresDay === null) {
    return unreadable(
      "This licence carries no readable expiry date and not enough to work one out, so its state is unknown.",
      { issuedOn },
    );
  }

  const derivedGrace = expiresDay + GRACE_DAYS;
  const reportedGrace = toDayNumber(row.grace_until);
  if (reportedGrace !== null && reportedGrace !== derivedGrace) {
    return unreadable(
      `This licence disagrees with itself: ${GRACE_DAYS} days of grace after ${dayNumberToIso(expiresDay)} ends ${dayNumberToIso(derivedGrace)}, but it records ${dayNumberToIso(reportedGrace)}. It has not been dated here.`,
      { issuedOn, expiresOn: dayNumberToIso(expiresDay) },
    );
  }

  const expiresOn = dayNumberToIso(expiresDay);
  const graceUntil = dayNumberToIso(derivedGrace);
  const common = { issuedOn, expiresOn, graceUntil, validDays: validityIsUsable ? days : null };

  if (todayDay < expiresDay) {
    const daysRemaining = expiresDay - todayDay;
    return {
      ...common,
      status: LICENCE_STATUS.ACTIVE,
      daysRemaining,
      label: "Active",
      detail: `Active until ${expiresOn} — ${daysRemaining} ${daysRemaining === 1 ? "day" : "days"} left.`,
    };
  }
  if (todayDay < derivedGrace) {
    const daysRemaining = derivedGrace - todayDay;
    return {
      ...common,
      status: LICENCE_STATUS.GRACE,
      daysRemaining,
      label: "In grace period",
      detail: `Expired on ${expiresOn}. The device keeps working for another ${daysRemaining} ${daysRemaining === 1 ? "day" : "days"}, until ${graceUntil}.`,
    };
  }
  return {
    ...common,
    status: LICENCE_STATUS.EXPIRED,
    daysRemaining: 0,
    label: "Expired",
    detail: `Expired on ${expiresOn}; its grace period ended ${graceUntil}. Issue a new licence for this device.`,
  };
};

/** Every licence belonging to one device. Ids are compared canonically, never coerced. */
export const licencesForDevice = (licences, deviceId) => (
  (Array.isArray(licences) ? licences : []).filter((licence) => (
    inventoryIdsEqual(licence?.device_id, deviceId)
  ))
);

const rankLicence = (entry) => {
  const expires = toDayNumber(entry.classification.expiresOn);
  const issued = issuedDayOf(entry.licence && typeof entry.licence === "object" ? entry.licence : {});
  return [
    expires === null ? Number.NEGATIVE_INFINITY : expires,
    issued === null ? Number.NEGATIVE_INFINITY : issued,
    entry.index,
  ];
};

const laterThan = (candidate, incumbent) => {
  if (!incumbent) return true;
  const [a1, a2, a3] = rankLicence(candidate);
  const [b1, b2, b3] = rankLicence(incumbent);
  if (a1 !== b1) return a1 > b1;
  if (a2 !== b2) return a2 > b2;
  return a3 > b3;
};

const STATE_FROM_LICENCE = Object.freeze({
  [LICENCE_STATUS.ACTIVE]: DEVICE_ACTIVATION_STATE.ACTIVE,
  [LICENCE_STATUS.GRACE]: DEVICE_ACTIVATION_STATE.GRACE,
  [LICENCE_STATUS.EXPIRED]: DEVICE_ACTIVATION_STATE.EXPIRED,
  [LICENCE_STATUS.UNREADABLE]: DEVICE_ACTIVATION_STATE.UNREADABLE,
});

const STATE_LABELS = Object.freeze({
  [DEVICE_ACTIVATION_STATE.NEEDS_LICENCE]: "Needs a licence",
  [DEVICE_ACTIVATION_STATE.ACTIVE]: "Activated",
  [DEVICE_ACTIVATION_STATE.GRACE]: "In grace period",
  [DEVICE_ACTIVATION_STATE.EXPIRED]: "Expired",
  [DEVICE_ACTIVATION_STATE.UNREADABLE]: "Cannot be read",
});

/** The serial of a licence row, under either name the routes use. */
const serialOf = (row) => firstText(row?.entitlement_serial, row?.serial);

/**
 * What the screen shows for one registered device: does it need a licence, does it hold a
 * current one, or has the one it holds run out.
 *
 * A device with no device id is its own state rather than a row that looks issuable and then
 * fails at the server — there is nothing to bind a licence to.
 */
export const describeDeviceActivation = (device, licences, { today } = {}) => {
  const row = device && typeof device === "object" ? device : {};
  const deviceId = canonicalInventoryId(row.device_id);
  const deviceName = firstText(row.device_name) || (deviceId || "Unnamed device");
  const base = {
    deviceId,
    deviceName,
    registrationStatus: firstText(row.status).toUpperCase() || "UNKNOWN",
    branchName: text(row.branch_name),
    counterName: text(row.counter_name),
    lastActiveAt: text(row.last_active_at),
    licenceCount: 0,
    latest: null,
    serial: "",
    issuable: false,
  };

  if (!deviceId) {
    return {
      ...base,
      state: DEVICE_ACTIVATION_STATE.UNREADABLE,
      label: STATE_LABELS[DEVICE_ACTIVATION_STATE.UNREADABLE],
      detail: "This device registered without a device ID, so no licence can be bound to it. It has to register again before it can be activated.",
    };
  }

  const mine = licencesForDevice(licences, deviceId);
  const classified = mine.map((licence, index) => ({
    licence,
    index,
    classification: classifyLicence(licence, { today }),
  }));

  let best = null;
  for (const entry of classified) {
    if (entry.classification.status === LICENCE_STATUS.UNREADABLE) continue;
    if (laterThan(entry, best)) best = entry;
  }

  if (!best) {
    if (classified.length > 0) {
      // Licences exist but none could be dated. Saying "needs a licence" would be a guess, and
      // saying "expired" would be a different guess. Neither is known, so neither is claimed.
      return {
        ...base,
        licenceCount: classified.length,
        state: DEVICE_ACTIVATION_STATE.UNREADABLE,
        label: STATE_LABELS[DEVICE_ACTIVATION_STATE.UNREADABLE],
        detail: `This device has ${classified.length} licence ${classified.length === 1 ? "record" : "records"}, and none of them could be read. Its activation state is unknown — see the issued history below.`,
        issuable: true,
        latest: classified[classified.length - 1].classification,
      };
    }
    return {
      ...base,
      state: DEVICE_ACTIVATION_STATE.NEEDS_LICENCE,
      label: STATE_LABELS[DEVICE_ACTIVATION_STATE.NEEDS_LICENCE],
      detail: "No activation licence has been issued for this device yet.",
      issuable: true,
    };
  }

  const state = STATE_FROM_LICENCE[best.classification.status];
  return {
    ...base,
    licenceCount: classified.length,
    state,
    label: STATE_LABELS[state],
    detail: best.classification.detail,
    latest: best.classification,
    serial: serialOf(best.licence),
    issuable: true,
  };
};

const EMPTY_SUMMARY = Object.freeze({
  total: 0,
  needsLicence: 0,
  active: 0,
  grace: 0,
  expired: 0,
  unreadable: 0,
});

/**
 * Everything the screen renders, from one pass over the same two lists.
 *
 * Returns `{ ok: false, error }` whenever an input is missing or failed to load. That is the
 * point of the function: a device list without a licence list would render every counter in the
 * shop as "needs a licence" — zero licences presented as a fact, when the truth is that nobody
 * knows. CLAUDE.md records that failure mode; this is where it is refused.
 *
 * The summary is folded out of `rows`, the same array the table maps over, so the tiles and the
 * table cannot disagree.
 */
export const buildActivationIssuingView = ({
  devices,
  licences,
  devicesError = null,
  licencesError = null,
  today,
} = {}) => {
  const failure = (code, message) => ({ ok: false, error: { code, message }, rows: [], history: [], summary: EMPTY_SUMMARY });

  if (devicesError) {
    return failure(
      "DEVICES_UNAVAILABLE",
      `The list of devices could not be loaded (${firstText(devicesError.message, devicesError) || "no reason given"}), so no device can be shown as needing a licence.`,
    );
  }
  if (licencesError) {
    return failure(
      "LICENCES_UNAVAILABLE",
      `The issued licences could not be loaded (${firstText(licencesError.message, licencesError) || "no reason given"}), so it is not known which devices already have one.`,
    );
  }
  if (!Array.isArray(devices)) {
    return failure("DEVICES_UNAVAILABLE", "The list of devices has not loaded yet, so no device can be shown as needing a licence.");
  }
  if (!Array.isArray(licences)) {
    return failure("LICENCES_UNAVAILABLE", "The issued licences have not loaded yet, so it is not known which devices already have one.");
  }

  const rows = devices.map((device) => describeDeviceActivation(device, licences, { today }));

  const summary = rows.reduce((totals, row) => ({
    total: totals.total + 1,
    needsLicence: totals.needsLicence + (row.state === DEVICE_ACTIVATION_STATE.NEEDS_LICENCE ? 1 : 0),
    active: totals.active + (row.state === DEVICE_ACTIVATION_STATE.ACTIVE ? 1 : 0),
    grace: totals.grace + (row.state === DEVICE_ACTIVATION_STATE.GRACE ? 1 : 0),
    expired: totals.expired + (row.state === DEVICE_ACTIVATION_STATE.EXPIRED ? 1 : 0),
    unreadable: totals.unreadable + (row.state === DEVICE_ACTIVATION_STATE.UNREADABLE ? 1 : 0),
  }), EMPTY_SUMMARY);

  const history = licences
    .map((licence, index) => ({ licence, index, classification: classifyLicence(licence, { today }) }))
    .sort((left, right) => (laterThan(left, right) ? -1 : 1))
    .map(({ licence, classification }) => {
      const row = licence && typeof licence === "object" ? licence : {};
      const deviceId = canonicalInventoryId(row.device_id);
      // `device_name` is the name captured when the file was issued; `current_device_name` is the
      // device row as it stands today, and is null once the device has been retired. Both are
      // shown, because "Counter 2" on a file and "Counter 2" on the shelf are not the same claim.
      const issuedForName = firstText(row.device_name);
      const currentName = firstText(row.current_device_name);
      const deviceStatus = firstText(row.device_status).toUpperCase();
      return {
        id: firstText(row.id),
        deviceId,
        deviceName: issuedForName || currentName || deviceId || "Unknown device",
        currentDeviceName: currentName,
        renamedSince: Boolean(issuedForName && currentName && issuedForName !== currentName),
        deviceStatus: deviceStatus || "",
        deviceRetired: currentName === "" && deviceStatus === "",
        serial: serialOf(row),
        validDays: finiteNumber(row.valid_days),
        issuedAt: firstText(row.issued_on, row.issued_at),
        issuedBy: firstText(row.issued_by_name, row.issued_by_username) || "Not recorded",
        downloadable: firstText(row.id) !== "",
        classification,
      };
    });

  return { ok: true, error: null, rows, history, summary };
};

/** The devices the Owner is most likely to be here for, first. */
export const ISSUING_PRIORITY = Object.freeze([
  DEVICE_ACTIVATION_STATE.NEEDS_LICENCE,
  DEVICE_ACTIVATION_STATE.EXPIRED,
  DEVICE_ACTIVATION_STATE.GRACE,
  DEVICE_ACTIVATION_STATE.UNREADABLE,
  DEVICE_ACTIVATION_STATE.ACTIVE,
]);

/** `rows` ordered for the picker: awaiting activation at the top, already-activated last. */
export const orderDevicesForIssuing = (rows) => (
  (Array.isArray(rows) ? [...rows] : []).sort((left, right) => {
    const rank = ISSUING_PRIORITY.indexOf(left.state) - ISSUING_PRIORITY.indexOf(right.state);
    if (rank !== 0) return rank;
    return left.deviceName.localeCompare(right.deviceName);
  })
);

/**
 * The request body for `POST /api/activation/licences`, or the reason there isn't one.
 *
 * The device id is taken from the row the Owner picked and passed through unchanged — it is an
 * opaque string and must never be re-derived, re-cased or coerced on the way to the server.
 */
export const buildIssueRequest = ({ deviceId, validDays } = {}) => {
  const id = canonicalInventoryId(deviceId);
  if (!id) {
    return {
      ok: false,
      code: "NO_DEVICE_SELECTED",
      message: "Pick the device this activation is for before issuing it.",
    };
  }
  const validity = validateValidDays(validDays);
  if (!validity.ok) return validity;
  return { ok: true, body: { device_id: id, valid_days: validity.validDays } };
};

/**
 * Every refusal the three routes can answer with, in words the Owner can act on.
 *
 * An unrecognised code falls through to the server's own message, shown verbatim, wrapped in a
 * sentence that says plainly that nothing was issued — "the request failed" with no visible
 * outcome is how somebody ends up believing a counter was activated when it was not.
 */
const ACTIVATION_FAILURES = Object.freeze({
  NOT_OWNER: "Only the Owner can issue an activation licence. This account is not the Owner, so nothing was issued.",
  NO_SUCH_DEVICE: "The server does not know this device, so it cannot be activated. The device has to connect once and register itself before a licence can be bound to it.",
  INVALID_DEVICE_ID: "The server would not accept that device ID. Pick the device from the list again — it may have been retired since the list was loaded.",
  SIGNING_KEY_UNAVAILABLE: "The activation signing key is not available on the server, so no licence was issued and nothing was changed. This needs the maintainer.",
  TRUSTED_KEYS_UNAVAILABLE: "The server could not read the keys this app trusts, so it refused to sign a licence the counter would then reject. Nothing was issued. This needs the maintainer.",
  ISSUE_FAILED: "The server could not complete the issue, so no licence was created. Nothing on the device has changed.",
  INVALID_LICENCE_ID: "That licence record could not be identified, so its file could not be fetched.",
  NO_SUCH_LICENCE: "That licence is no longer on the server, so its file could not be fetched. Issue a new licence for the device instead.",
});

const failureSentence = ({ code, message, status } = {}, fallbackLead) => {
  const known = ACTIVATION_FAILURES[firstText(code).toUpperCase()];
  if (known) return known;
  if (firstText(code).toUpperCase() === "INVALID_VALID_DAYS") {
    const detail = firstText(message);
    return `The server refused that validity${detail ? ` (${detail})` : ""}. Choose a whole number of days between ${VALID_DAYS_MIN} and ${VALID_DAYS_MAX}.`;
  }
  const httpStatus = finiteNumber(status);
  const statusText = httpStatus === null ? "" : ` (HTTP ${httpStatus})`;
  return `${fallbackLead}${statusText}. ${firstText(message) || "The server gave no reason."}`;
};

/** For `POST /api/activation/licences`. */
export const describeIssueFailure = (failure) => failureSentence(failure, "No licence was issued");

/** For `GET /api/activation/licences/:id/file`. Nothing was issued or changed by a failed read. */
export const describeLicenceFileFailure = (failure) => (
  failureSentence(failure, "The activation file could not be fetched")
);

/**
 * Is what came back actually a licence file?
 *
 * The `.lic` container is `format:`, `payload:` and `signature:` lines plus `#` comments
 * (src-tauri/src/activation.rs). Saving an empty or truncated one would hand the Owner a file
 * that fails on the counter, in another town, days later — so it is checked before it is offered.
 */
export const LIC_CONTAINER_FORMAT = "FRZ-LIC/1";

export const validateLicenceArtifact = (lic) => {
  if (typeof lic !== "string" || lic.trim() === "") {
    return {
      ok: false,
      code: "EMPTY_LICENCE",
      message: "The server reported success but sent no activation file, so there is nothing to save. Nothing has been issued to this device.",
    };
  }
  const lines = lic.split(/\r?\n/).map((line) => line.trim()).filter((line) => line !== "" && !line.startsWith("#"));
  const field = (key) => {
    const found = lines.find((line) => line.toLowerCase().startsWith(`${key}:`));
    return found === undefined ? null : found.slice(key.length + 1).trim();
  };
  const format = field("format");
  if (format !== LIC_CONTAINER_FORMAT) {
    return {
      ok: false,
      code: "UNKNOWN_LICENCE_FORMAT",
      message: `The activation file is not in the ${LIC_CONTAINER_FORMAT} format this app can read${format ? ` (it says "${format}")` : ""}, so it has not been offered for saving.`,
    };
  }
  if (!field("payload")) {
    return { ok: false, code: "MALFORMED_LICENCE", message: "The activation file has no payload line, so it would be refused by the device. It has not been offered for saving." };
  }
  if (!field("signature")) {
    return { ok: false, code: "MALFORMED_LICENCE", message: "The activation file has no signature line, so it would be refused by the device. It has not been offered for saving." };
  }
  return { ok: true };
};

const slug = (value) => text(value)
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, "-")
  .replace(/^-+|-+$/g, "")
  .slice(0, 48);

/**
 * The name the `.lic` is offered under.
 *
 * Carries the device and the serial so two files in the same folder are never ambiguous, and
 * never collapses to a bare extension when the device has no usable name.
 */
export const licenceFileName = ({ deviceName, deviceId, serial } = {}) => {
  const parts = ["froozerp-activation"];
  const name = slug(deviceName) || slug(deviceId);
  if (name) parts.push(name);
  const serialText = slug(serial);
  if (serialText) parts.push(serialText);
  if (parts.length === 1) parts.push("device");
  return `${parts.join("-")}.lic`;
};

/**
 * What to show after a licence comes back, whichever route it came from.
 *
 * Kept here rather than in the screen because it is the one place that turns a response into the
 * three things the Owner needs: a file name, a sentence about what he just made, and a dated
 * verdict he can check against the device.
 */
export const describeIssuedLicence = (response, { today, fallbackDeviceName, fallbackDeviceId } = {}) => {
  const data = response && typeof response === "object" ? response : {};
  const artifact = validateLicenceArtifact(data.lic);
  if (!artifact.ok) return { ok: false, code: artifact.code, message: artifact.message };

  const deviceId = canonicalInventoryId(firstText(data.device_id, fallbackDeviceId));
  const deviceName = firstText(data.device_name, fallbackDeviceName) || deviceId || "this device";
  const serial = serialOf(data);
  const classification = classifyLicence(data, { today });
  const validity = describeValidity(data.valid_days);
  return {
    ok: true,
    lic: data.lic,
    deviceId,
    deviceName,
    serial,
    classification,
    fileName: licenceFileName({ deviceName, deviceId, serial }),
    detail: classification.status === LICENCE_STATUS.UNREADABLE
      ? `Issued for ${deviceName}${validity === "Not set" ? "" : ` for ${validity}`}. ${classification.detail}`
      : `Issued for ${deviceName}, valid ${validity} — ${classification.detail}`,
  };
};
