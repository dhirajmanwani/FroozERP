/**
 * Getting a brand-new device onto the Owner's list, from the activation screen.
 *
 * A fresh installation opens on the activation screen, before any sign-in. The Owner issues its
 * activation file from Settings > Device Activation Licences, and that screen lists only devices
 * that have reached the cloud. A device reaches the cloud when somebody tries to sign in on it
 * (`/login` records it as PENDING) -- and the activation screen offered no sign-in. So a new
 * device could never be listed, and could never be activated. Found 26 Sep 2026 on the first
 * Android phone; a new Windows counter has the same dead end.
 *
 * The screen now sends one sign-in attempt, through the same `/login` the login screen uses, so the
 * device is recorded exactly as it always would have been. No new public route, and nothing is kept:
 * if the cloud answers with a session, it is dropped. This module only reads the answer.
 *
 * The file itself can also be pasted as text, because on a phone "save the .lic and pick it" is
 * several apps' worth of steps, while the Owner's screen already has "Copy File Text".
 */

export const ENROLMENT_OUTCOME = Object.freeze({
  WAITING_AT_SHOP: "WAITING_AT_SHOP",
  ALREADY_KNOWN: "ALREADY_KNOWN",
  WRONG_CREDENTIALS: "WRONG_CREDENTIALS",
  BLOCKED: "BLOCKED",
  UNREACHABLE: "UNREACHABLE",
  REFUSED: "REFUSED",
});

const ownerSteps = (deviceName) =>
  `On the Owner's computer: Branches & Counters > Step 4, approve "${deviceName || "this device"}", ` +
  "then Settings > Device Activation Licences, issue one for it and send the file or its text here.";

/**
 * What a `/login` attempt from the activation screen means for enrolment.
 *
 * Takes what axios gives: `{ response }` for a success, `{ error }` for a failure. Never reports
 * success for an answer it does not recognise.
 */
export const describeEnrolmentAttempt = ({ response, error, deviceName } = {}) => {
  if (response && !error) {
    return {
      outcome: ENROLMENT_OUTCOME.ALREADY_KNOWN,
      ok: true,
      message: `The shop already knows this device. Ask the Owner to issue its activation file: Settings > Device Activation Licences, "${deviceName || "this device"}".`,
    };
  }
  if (error?.blocked === true && error?.reachedCloud === false) {
    return {
      outcome: ENROLMENT_OUTCOME.REFUSED,
      ok: false,
      message: String(error?.message || "This device is set to Local Only, so it cannot reach the shop."),
    };
  }
  const status = Number(error?.response?.status);
  const data = error?.response?.data || {};
  const code = String(data.code || "").toUpperCase();
  if (!error?.response) {
    return {
      outcome: ENROLMENT_OUTCOME.UNREACHABLE,
      ok: false,
      message: "The shop's cloud could not be reached. Check the internet on this device and try again.",
    };
  }
  if (code === "DEVICE_PENDING_APPROVAL") {
    return {
      outcome: ENROLMENT_OUTCOME.WAITING_AT_SHOP,
      ok: true,
      message: `Sent. This device is now waiting at the shop. ${ownerSteps(deviceName)}`,
    };
  }
  if (code === "DEVICE_DISABLED" || code === "DEVICE_REVOKED") {
    return {
      outcome: ENROLMENT_OUTCOME.BLOCKED,
      ok: false,
      message: "The Owner has blocked this device. Only the Owner can allow it again.",
    };
  }
  if (status === 401 || code === "INVALID_CREDENTIALS") {
    return {
      outcome: ENROLMENT_OUTCOME.WRONG_CREDENTIALS,
      ok: false,
      message: String(data.message || "Username or password is wrong. Nothing was sent."),
    };
  }
  return {
    outcome: ENROLMENT_OUTCOME.REFUSED,
    ok: false,
    message: String(data.message || `The shop refused this device (HTTP ${Number.isFinite(status) ? status : "error"}).`),
  };
};

/** Pasted activation text, trimmed. Whether it is a valid file is the Rust shell's decision. */
export const readPastedActivation = (text) => {
  const contents = String(text ?? "").trim();
  if (!contents) {
    return { ok: false, message: "Paste the activation text the Owner sent, then press Activate." };
  }
  return { ok: true, contents };
};
