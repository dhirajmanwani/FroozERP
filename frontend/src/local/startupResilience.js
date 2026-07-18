export const RUNTIME_FAILURE_EVENT = "froozerp-runtime-failure";

export const shouldShowFatalStartup = ({ mandatoryRuntimeFailed, retriesExhausted }) => (
  mandatoryRuntimeFailed === true && retriesExhausted === true
);

export const resolveMandatoryRuntimeRenderState = ({ status, retriesExhausted = false }) => {
  if (!status) return "checking";
  if (status.initialized) return "ready";
  return retriesExhausted ? "fatal" : "checking";
};

export const resolveLocalServiceRenderState = ({ healthOnline, retriesExhausted = false }) => {
  if (healthOnline === true) return "ready";
  return retriesExhausted ? "fatal" : "checking";
};

export const initialiseMandatoryRuntime = async ({ initialize, attempts = 4, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) => {
  let status = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      status = await initialize();
    } catch (error) {
      status = { initialized: false, error: error?.message || String(error) };
    }
    if (status?.initialized) return { status, attemptsUsed: attempt, retriesExhausted: false };
    if (attempt < attempts) await delay(250 * attempt);
  }
  return { status, attemptsUsed: attempts, retriesExhausted: true };
};

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
