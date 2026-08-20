"use strict";

const crypto = require("node:crypto");

const TOKEN_VERSION = "v1";
const DEFAULT_TTL_SECONDS = 12 * 60 * 60;

const encode = (value) => Buffer.from(value, "utf8").toString("base64url");
const decode = (value) => Buffer.from(value, "base64url").toString("utf8");
const sign = (value, secret) => crypto.createHmac("sha256", secret).update(value).digest("base64url");

const issueDeviceSession = ({
  userId,
  deviceId,
  companyId,
  branchId,
  role = "",
  sessionRevocationVersion = 0,
  nowMs = Date.now(),
  ttlSeconds = DEFAULT_TTL_SECONDS,
  secret,
}) => {
  if (!secret || !userId || !deviceId || !companyId || !branchId) {
    throw new Error("Canonical device session scope is incomplete");
  }
  const payload = encode(JSON.stringify({
    user_id: Number(userId),
    device_id: String(deviceId),
    company_id: Number(companyId),
    branch_id: Number(branchId),
    // Added in auth-hardening A-3 so `requireRole` can authorise without a database round trip.
    // Deliberately NOT part of the completeness check above: a token minted before A-3 carries no
    // role and must still verify, and `requireRole` fails closed when the claim is absent rather
    // than treating "no role" as permission.
    role: String(role || ""),
    session_revocation_version: Number(sessionRevocationVersion || 0),
    issued_at: Math.floor(nowMs / 1000),
    expires_at: Math.floor(nowMs / 1000) + Number(ttlSeconds),
  }));
  const unsigned = `${TOKEN_VERSION}.${payload}`;
  return `${unsigned}.${sign(unsigned, secret)}`;
};

const verifyDeviceSession = (token, secret, nowMs = Date.now()) => {
  const parts = String(token || "").split(".");
  if (!secret || parts.length !== 3 || parts[0] !== TOKEN_VERSION) {
    return { error: { status: 401, code: "DEVICE_SESSION_REQUIRED", message: "Authenticated device session is required" } };
  }
  const unsigned = `${parts[0]}.${parts[1]}`;
  const expected = sign(unsigned, secret);
  const suppliedBuffer = Buffer.from(parts[2]);
  const expectedBuffer = Buffer.from(expected);
  if (suppliedBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(suppliedBuffer, expectedBuffer)) {
    return { error: { status: 401, code: "DEVICE_SESSION_INVALID", message: "Authenticated device session is invalid" } };
  }
  let claims;
  try {
    claims = JSON.parse(decode(parts[1]));
  } catch {
    return { error: { status: 401, code: "DEVICE_SESSION_INVALID", message: "Authenticated device session is invalid" } };
  }
  if (
    !Number.isInteger(claims.user_id) ||
    claims.user_id <= 0 ||
    !String(claims.device_id || "").trim() ||
    !Number.isInteger(claims.company_id) ||
    claims.company_id <= 0 ||
    !Number.isInteger(claims.branch_id) ||
    claims.branch_id <= 0
  ) {
    return { error: { status: 401, code: "DEVICE_SESSION_INVALID", message: "Authenticated device session scope is invalid" } };
  }
  if (!Number.isFinite(claims.expires_at) || claims.expires_at <= Math.floor(nowMs / 1000)) {
    return { error: { status: 401, code: "DEVICE_SESSION_EXPIRED", message: "Authenticated device session has expired" } };
  }
  return { claims };
};

const rejectDeviceSessionSubstitution = (claims, submitted = {}) => {
  const comparisons = [
    ["user_id", Number],
    ["device_id", String],
    ["company_id", Number],
    ["branch_id", Number],
  ];
  for (const [field, convert] of comparisons) {
    if (submitted[field] == null || String(submitted[field]).trim() === "") continue;
    if (convert(submitted[field]) !== convert(claims[field])) {
      return {
        status: 403,
        code: "DEVICE_SESSION_SUBSTITUTION_REJECTED",
        message: `${field} does not match the authenticated device session`,
      };
    }
  }
  return null;
};

module.exports = {
  DEFAULT_TTL_SECONDS,
  issueDeviceSession,
  rejectDeviceSessionSubstitution,
  verifyDeviceSession,
};
