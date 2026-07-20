export const FROST_CLOUD_UNAVAILABLE_MESSAGE =
  "FROST requires cloud access. Local FroozERP modules remain available.";

const CLOUD_TRANSPORT_CODES = new Set([
  "CLOUD_UNAVAILABLE",
  "CLOUD_UNREACHABLE",
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
