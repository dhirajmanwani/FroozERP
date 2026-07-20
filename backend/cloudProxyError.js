const CLOUD_NETWORK_CODES = new Set([
  "ENOTFOUND",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const CLOUD_UNAVAILABLE_MESSAGE = "FroozERP cloud is temporarily unavailable. Local modules remain available.";

const normalizeCloudProxyError = (error = {}) => {
  if (["APP_INTERNET_DISABLED", "APP_LOCAL_ONLY"].includes(error.code)) {
    return {
      status: 503,
      payload: {
        code: "APP_LOCAL_ONLY",
        failure_kind: "CLOUD_UNAVAILABLE",
        cloud_connected: false,
        message: "Local Only mode selected - cloud sync paused. Local modules remain available.",
      },
    };
  }
  const causeCode = String(error?.cause?.code || error?.code || "").toUpperCase();
  const status = Number(error?.status || error?.response?.status || 0);
  if (CLOUD_NETWORK_CODES.has(causeCode) || [502, 503, 504].includes(status) || error?.name === "TimeoutError") {
    return {
      status: 503,
      payload: {
        code: "CLOUD_UNAVAILABLE",
        failure_kind: "CLOUD_UNAVAILABLE",
        cloud_connected: false,
        message: CLOUD_UNAVAILABLE_MESSAGE,
      },
    };
  }
  return {
    status: 502,
    payload: {
      code: "CLOUD_UNAVAILABLE",
      failure_kind: "CLOUD_UNAVAILABLE",
      cloud_connected: false,
      message: CLOUD_UNAVAILABLE_MESSAGE,
    },
  };
};

module.exports = { CLOUD_UNAVAILABLE_MESSAGE, normalizeCloudProxyError };
