export const RUNTIME_FAILURE_EVENT = "froozerp-runtime-failure";

export const shouldShowFatalStartup = ({ reactMounted }) => reactMounted !== true;

export const describeRequestFailure = (error, fallback = {}) => ({
  method: String(error?.config?.method || fallback.method || "GET").toUpperCase(),
  url: error?.config?.url || fallback.url || "unknown",
  status: error?.response?.status ?? null,
  code: error?.response?.data?.code || error?.code || "NETWORK_ERROR",
  message: error?.response?.data?.message || error?.message || "Request failed",
});

export const settleNamedRequests = async (requests) => {
  const results = await Promise.allSettled(requests.map((request) => request.run()));
  const values = {};
  const failures = [];

  results.forEach((result, index) => {
    const request = requests[index];
    if (result.status === "fulfilled") {
      values[request.key] = result.value;
      return;
    }
    values[request.key] = request.fallback;
    failures.push({
      key: request.key,
      ...describeRequestFailure(result.reason, request),
    });
  });

  return { values, failures };
};
