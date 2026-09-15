"use strict";

/**
 * What the Owner asked for, checked before anything is signed.
 *
 * This is deliberately separate from `activationLicence.js`, which owns the wire format. That
 * module refuses bad input too, but it refuses in the vocabulary of the format ("validDays must be
 * 1…65535"). This one refuses in the vocabulary of the screen, so the Owner is told which box to
 * fix, and so the refusals can be proven without a signing key or a database.
 *
 * ## Why the ceiling is ten years and not 65535 days
 *
 * The wire field is a u16, so the format would accept 179 years. A licence that outlives the
 * business is not a time frame, it is a missing time frame, and the whole point of this feature is
 * that activation has one. 3650 days is long enough for any real answer to "how long should this
 * counter work for" and short enough that a fat-fingered entry is caught here rather than on a
 * machine in another town.
 *
 * ## Why `Number()` is not used on its own
 *
 * `Number("")`, `Number(null)` and `Number([])` are all 0, and 0 is a number that passes a
 * `typeof` check. CLAUDE.md records the same family of bug ("`??` does not fall through on `0`")
 * from a day it emptied a screen. So a value is accepted only if it is already a finite number or
 * a string of digits, and anything else is refused by name.
 */

const MIN_VALID_DAYS = 1;
const MAX_VALID_DAYS = 3650;
const MAX_DEVICE_ID_LENGTH = 160;

/** Whole-number days, from a number or a string of digits. `null` for anything else. */
const readWholeDays = (value) => {
  if (typeof value === "number") {
    return Number.isInteger(value) ? value : null;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^[0-9]+$/.test(trimmed)) return null;
    const parsed = Number(trimmed);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
};

/**
 * Check an activation request.
 *
 * @param {object} body Request body: `device_id` and `valid_days`.
 * @returns {{ok: true, deviceId: string, validDays: number}
 *          |{ok: false, status: number, code: string, message: string}}
 *          A refusal carries the HTTP status with it so the route cannot pair a code with the
 *          wrong one.
 */
const normaliseLicenceRequest = (body) => {
  const source = body && typeof body === "object" ? body : {};

  const deviceId = typeof source.device_id === "string" ? source.device_id.trim() : "";
  if (!deviceId) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_DEVICE_ID",
      message: "Choose which device this activation file is for.",
    };
  }
  if (deviceId.length > MAX_DEVICE_ID_LENGTH) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_DEVICE_ID",
      message: `A device id is at most ${MAX_DEVICE_ID_LENGTH} characters.`,
    };
  }

  const validDays = readWholeDays(source.valid_days);
  if (validDays === null) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_VALID_DAYS",
      message: "Enter how many days this activation should last, as a whole number.",
    };
  }
  if (validDays < MIN_VALID_DAYS || validDays > MAX_VALID_DAYS) {
    return {
      ok: false,
      status: 400,
      code: "INVALID_VALID_DAYS",
      message: `Choose between ${MIN_VALID_DAYS} and ${MAX_VALID_DAYS} days.`,
    };
  }

  return { ok: true, deviceId, validDays };
};

module.exports = {
  normaliseLicenceRequest,
  readWholeDays,
  MIN_VALID_DAYS,
  MAX_VALID_DAYS,
  MAX_DEVICE_ID_LENGTH,
};
