// Cloud target resolution.
//
// The defect this module exists to prevent (backlog items 3/4, audit item 7): a `||` chain
// that treats "not configured" as "use the most capable default". A build with no cloud
// configuration must contact nothing. The less configuration a machine has, the *less* it
// should reach, never the more.
//
// Nothing in here may name a production host. There is deliberately no default target
// parameter -- a caller cannot accidentally reintroduce one through this module.

export const CLOUD_TARGET_REFUSAL_CODE = "CLOUD_NOT_CONFIGURED";

export const CLOUD_NOT_CONFIGURED_MESSAGE =
  "No cloud backend is configured for this installation. The request was refused instead of being sent to a default target.";

export const normalizeCloudTargetValue = (value) =>
  String(value ?? "").trim().replace(/\/+$/, "");

export const isCloudTargetConfigured = (value) => normalizeCloudTargetValue(value) !== "";

/**
 * Return the first candidate that is actually configured. When every candidate is empty the
 * result is an explicit "not configured" -- never a fallback URL.
 */
export const resolveCloudTarget = (candidates = []) => {
  const list = Array.isArray(candidates) ? candidates : [candidates];
  for (const candidate of list) {
    const url = normalizeCloudTargetValue(candidate);
    if (url) return { configured: true, url };
  }
  return { configured: false, url: "" };
};

export const describeCloudTargetRefusal = (operation = "cloud request") => Object.freeze({
  allowed: false,
  blocked: true,
  reachedCloud: false,
  code: CLOUD_TARGET_REFUSAL_CODE,
  operation: String(operation || "cloud request"),
  message: CLOUD_NOT_CONFIGURED_MESSAGE,
});

export const createCloudNotConfiguredError = (operation = "cloud request") => {
  const refusal = describeCloudTargetRefusal(operation);
  const error = new Error(refusal.message);
  error.code = refusal.code;
  error.operation = refusal.operation;
  error.blocked = true;
  error.reachedCloud = false;
  return error;
};

/**
 * Throw a named refusal rather than letting an empty base URL turn `${base}/api/health`
 * into a same-origin relative request. That silent no-op is what made "no cloud configured"
 * indistinguishable from "cloud is down" at every call site.
 */
export const assertCloudTargetConfigured = (value, operation = "cloud request") => {
  const url = normalizeCloudTargetValue(value);
  if (!url) throw createCloudNotConfiguredError(operation);
  return url;
};
