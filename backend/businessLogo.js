"use strict";

/**
 * The shop's own logo: the one decision about what `business_settings.logo_url` may hold.
 *
 * Pure on purpose, like `productPosSection.js`: the business-settings route in `server.js` calls
 * this and nothing else, so the rule is testable without a database.
 *
 * ## What is accepted
 *
 * Nothing (no logo: the app shows the Frooz mark it ships with), or a picture as a `data:` URL,
 * under exactly the rules a product photo follows (`productPhoto.js`): JPEG, PNG or WebP, strict
 * base64, at most 200 KB, and bytes that really are the format they claim. The frontend shrinks the
 * picked picture well under that before sending it.
 *
 * A web address is refused, never stored. The logo is drawn on every screen of every counter, and
 * an address there would make each counter fetch it from the internet, which LOCAL_ONLY forbids.
 *
 * ## The one exception: what is already saved
 *
 * The field used to be a free-text "Logo URL / Path" box that nothing read. Whatever someone typed
 * there is still in the row, and the settings screen sends the row back on every save. Refusing it
 * would make Business Identity unsaveable until someone found and cleared a box that no longer
 * exists, and clearing it quietly would throw away what they typed. So a value identical to the one
 * already stored is kept as it is; the screen ignores it when drawing.
 *
 * ## What a refusal looks like
 *
 * `{ ok: false, code, message }`, the message written for the shop owner.
 */

const { validateProductPhoto } = require("./productPhoto");

const LOGO_MESSAGES = Object.freeze({
  PHOTO_FORMAT_UNSUPPORTED: "The logo must be a picture (JPEG, PNG or WebP) chosen with \"Choose logo\". A web address or file path cannot be used.",
  PHOTO_NOT_BASE64: "The logo picture could not be read. Choose it again.",
  PHOTO_TOO_LARGE: "The logo picture is larger than 200 KB. Choose a smaller picture.",
  PHOTO_CONTENT_MISMATCH: "This file is not a real picture, although it is named like one. Choose a different logo.",
});

/**
 * @param {unknown} value      what the client sent as `logo_url`
 * @param {unknown} storedValue what the row holds now
 * @returns {{ ok: true, value: string | null } | { ok: false, code: string, message: string }}
 */
const parseBusinessLogo = (value, storedValue = null) => {
  // Not sent at all is "leave it": a partial save (another settings tab, a script) used to delete
  // the shop's logo. `null` or "" sent on purpose still clears it.
  if (value === undefined) return { ok: true, value: typeof storedValue === "string" ? storedValue : null };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, code: "LOGO_INVALID", message: LOGO_MESSAGES.PHOTO_FORMAT_UNSUPPORTED };
  }
  if (value.trim() === "") return { ok: true, value: null };
  if (typeof storedValue === "string" && value === storedValue) return { ok: true, value };
  const checked = validateProductPhoto(value);
  if (checked.ok) return { ok: true, value: checked.dataUrl };
  return {
    ok: false,
    code: "LOGO_INVALID",
    message: LOGO_MESSAGES[checked.code] || LOGO_MESSAGES.PHOTO_FORMAT_UNSUPPORTED,
  };
};

module.exports = { parseBusinessLogo };
