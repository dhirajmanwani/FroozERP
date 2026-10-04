export const FROST_CLOUD_UNAVAILABLE_MESSAGE =
  "FROST requires cloud access. Local FroozERP modules remain available.";

const CLOUD_TRANSPORT_CODES = new Set([
  "CLOUD_UNAVAILABLE",
  "CLOUD_UNREACHABLE",
  "APP_LOCAL_ONLY",
  "APP_INTERNET_DISABLED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "ERR_NETWORK",
]);

export const deriveRuntimeConnectivity = ({
  localHealth = {},
  internetAvailable = false,
  cloudHealth = {},
  deviceApproved = false,
} = {}) => {
  const localServerConnected = localHealth?.online === true;
  const cloudConnected = internetAvailable === true && cloudHealth?.online === true;
  return {
    localServerConnected,
    internetAvailable: internetAvailable === true,
    cloudConnected,
    syncAvailable: localServerConnected && cloudConnected && deviceApproved === true,
  };
};

export const isCloudUnavailableError = (error = {}) => {
  const status = Number(error?.response?.status || error?.status || 0);
  const code = String(
    error?.response?.data?.code
      || error?.response?.data?.failure_kind
      || error?.code
      || error?.cause?.code
      || "",
  ).toUpperCase();
  return [502, 503, 504].includes(status) || CLOUD_TRANSPORT_CODES.has(code);
};

export const getFrostAvailabilityMessage = ({
  error = null,
  internetAvailable = true,
  cloudConnected = null,
} = {}) => {
  if (internetAvailable === false || cloudConnected === false || isCloudUnavailableError(error)) {
    return FROST_CLOUD_UNAVAILABLE_MESSAGE;
  }
  return "";
};

export const preserveVerifiedLocalCollection = (remoteValue, localValue) => {
  if (Array.isArray(localValue) && localValue.length > 0 && (!Array.isArray(remoteValue) || remoteValue.length === 0)) {
    return localValue;
  }
  return Array.isArray(remoteValue) ? remoteValue : (Array.isArray(localValue) ? localValue : []);
};

/**
 * The value to keep from one reference request: a collection, or a single object such as the
 * `/settings` bundle (4 Oct 2026).
 *
 * Every reference request used to go through `preserveVerifiedLocalCollection`, which only knows
 * arrays, so an object answer came back as `[]`. The whole settings bundle the cloud sent at
 * sign-in was thrown away, role permissions with it, and a Cashier was left with only the three
 * screens the app grants by default: Sale Returns and Orders, which the Cashier's `billing`
 * permission opens, never appeared. Owner and Admin did not notice because they are granted
 * everything without reading a permission.
 *
 * A collection keeps the collection rule. An object answer is taken as sent; when the answer is not
 * an object, the cached object stays.
 */
export const preserveVerifiedLocalValue = (remoteValue, localValue) => {
  if (Array.isArray(localValue) || Array.isArray(remoteValue)) {
    return preserveVerifiedLocalCollection(remoteValue, localValue);
  }
  const isObject = (value) => value !== null && typeof value === "object";
  if (isObject(remoteValue)) return remoteValue;
  return isObject(localValue) ? localValue : {};
};
