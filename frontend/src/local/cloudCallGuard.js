// One place that decides whether a cloud call may leave this device.
//
// `CLAUDE.md`: "LOCAL_ONLY mode must keep blocked=true, reachedCloud=false, cloud-router
// invocations at 0, and external connections at 0."
//
// Three independent reasons can refuse a call, and they are checked in this order so the
// most authoritative reason is the one reported:
//
//   1. API_MODE=LOCAL_ONLY   -- ruled authoritative over connectivity mode (D-16, backlog
//      item 4 option 1). The name promises a guarantee, so it now delivers one.
//   2. Owner connectivity policy LOCAL_ONLY -- the backend-confirmed kill switch.
//   3. No cloud target configured -- refusing beats letting an empty base URL degrade into
//      a same-origin relative request that looks like an ordinary network failure.

import { CLOUD_NOT_CONFIGURED_MESSAGE, CLOUD_TARGET_REFUSAL_CODE, isCloudTargetConfigured } from "./cloudTarget.js";
import { isLocalOnlyApiMode } from "./apiModeResolution.js";

export const CLOUD_CALL_REFUSAL_CODES = Object.freeze({
  API_MODE_LOCAL_ONLY: "API_MODE_LOCAL_ONLY",
  APP_LOCAL_ONLY: "APP_LOCAL_ONLY",
  CLOUD_NOT_CONFIGURED: CLOUD_TARGET_REFUSAL_CODE,
});

export const CLOUD_CALL_REFUSAL_MESSAGES = Object.freeze({
  [CLOUD_CALL_REFUSAL_CODES.API_MODE_LOCAL_ONLY]:
    "This installation runs in Local Only API mode, so no cloud request is made.",
  [CLOUD_CALL_REFUSAL_CODES.APP_LOCAL_ONLY]:
    "Local Only mode selected - cloud sync paused.",
  [CLOUD_CALL_REFUSAL_CODES.CLOUD_NOT_CONFIGURED]: CLOUD_NOT_CONFIGURED_MESSAGE,
});

const refuse = (operation, code) => Object.freeze({
  allowed: false,
  blocked: true,
  reachedCloud: false,
  operation: String(operation || "cloud request"),
  code,
  message: CLOUD_CALL_REFUSAL_MESSAGES[code],
  target: "",
});

/**
 * @returns {{allowed: boolean, blocked: boolean, reachedCloud: boolean, operation: string,
 *            code: string, message: string, target: string}}
 */
export const evaluateCloudCall = ({ operation = "cloud request", target = "", localOnly = false, apiMode = "" } = {}) => {
  if (isLocalOnlyApiMode(apiMode)) return refuse(operation, CLOUD_CALL_REFUSAL_CODES.API_MODE_LOCAL_ONLY);
  if (localOnly === true) return refuse(operation, CLOUD_CALL_REFUSAL_CODES.APP_LOCAL_ONLY);
  if (!isCloudTargetConfigured(target)) return refuse(operation, CLOUD_CALL_REFUSAL_CODES.CLOUD_NOT_CONFIGURED);
  return Object.freeze({
    allowed: true,
    blocked: false,
    reachedCloud: false,
    operation: String(operation || "cloud request"),
    code: "",
    message: "",
    target: String(target).trim().replace(/\/+$/, ""),
  });
};

export const createCloudCallRefusalError = (decision) => {
  const error = new Error(decision.message);
  error.code = decision.code;
  error.operation = decision.operation;
  error.blocked = true;
  error.reachedCloud = false;
  return error;
};

export const assertCloudCallAllowed = (input) => {
  const decision = evaluateCloudCall(input);
  if (!decision.allowed) throw createCloudCallRefusalError(decision);
  return decision;
};

/**
 * Bind the ambient facts once (API mode plus a live connectivity reader) so call sites read
 * as a single `guard.evaluate("login", url)` rather than repeating the whole condition.
 */
export const createCloudCallGuard = ({ apiMode = "", isLocalOnly = () => false } = {}) => ({
  apiMode,
  evaluate: (operation, target) => evaluateCloudCall({
    operation,
    target,
    localOnly: isLocalOnly() === true,
    apiMode,
  }),
  assert: (operation, target) => assertCloudCallAllowed({
    operation,
    target,
    localOnly: isLocalOnly() === true,
    apiMode,
  }),
});
