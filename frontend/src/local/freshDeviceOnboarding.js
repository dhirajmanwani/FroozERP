export const DEVICE_BOOTSTRAP_CODES = Object.freeze({
  APPROVED: "DEVICE_APPROVED",
  NOT_REGISTERED: "DEVICE_NOT_REGISTERED",
  PENDING: "DEVICE_PENDING_APPROVAL",
});

export function normalizeDeviceBootstrapStatus(payload = {}, deviceId = "") {
  const status = String(payload.device_status || "").trim().toUpperCase();
  const approved = payload.approved === true || status === "APPROVED";
  return {
    code: approved
      ? DEVICE_BOOTSTRAP_CODES.APPROVED
      : String(payload.code || (status === "PENDING" ? DEVICE_BOOTSTRAP_CODES.PENDING : `DEVICE_${status || "UNKNOWN"}`)),
    device_id: String(payload.device_id || deviceId || "").trim(),
    device_status: approved ? "APPROVED" : status || "UNKNOWN",
    approved,
    company_id: payload.company_id || null,
    branch_id: payload.branch_id || null,
  };
}

export function approvedDeviceCredentialMessage(errorPayload = {}) {
  if (errorPayload.code !== "CANONICAL_CREDENTIALS_REQUIRED") return "";
  return errorPayload.message
    || "Device approved. Enter the password for the canonical FroozERP account to finish secure provisioning.";
}

/**
 * What a brand-new device does when its first full download from the shop fails.
 *
 * On a device whose SQLite has no profile yet, sign-in first runs `initialPullForApprovedDevice`
 * (the reference bootstrap), then fetches the ordinary reference snapshot (`/products`,
 * `/inventory`, ...) and caches it into SQLite. The bootstrap is refused with 409
 * OPERATIONAL_SCOPE_REQUIRED whenever the cloud is not in `enforce` scope mode -- which is the
 * shipped default, and the only mode the app can run under today. The refusal was thrown straight
 * out of sign-in, the snapshot step never ran, and the device was left with no products and no
 * stock. Found 26 Sep 2026 on the first Android phone, whose POS was empty; a new Windows counter
 * would be the same.
 *
 * The bootstrap is an optimisation over the ordinary snapshot, which every existing device already
 * relies on. So its failure is recorded and shown, and sign-in continues to the snapshot.
 */

const firstText = (...values) => values.map((value) => String(value ?? "").trim()).find(Boolean) || "";

export const describeInitialPullFailure = (error) => {
  const status = Number(error?.response?.status);
  const code = firstText(error?.response?.data?.code, error?.code).toUpperCase() || "INITIAL_PULL_FAILED";
  const reason = firstText(error?.response?.data?.message, error?.message, "unknown error");
  return {
    log: {
      code,
      status: Number.isFinite(status) ? status : null,
      message: reason,
    },
    notice:
      `This device's first full download from the shop did not finish (${code}: ${reason}). ` +
      "Products and stock are being loaded the ordinary way instead.",
  };
};
