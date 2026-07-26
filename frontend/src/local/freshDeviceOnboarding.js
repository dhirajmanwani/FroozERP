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
