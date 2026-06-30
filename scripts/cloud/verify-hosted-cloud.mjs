import net from "node:net";

const baseUrl = String(process.env.CLOUD_API_URL || "").trim().replace(/\/$/, "");
const verifyUserId = String(process.env.VERIFY_USER_ID || "").trim();
const deviceId = String(process.env.DEVICE_ID || "").trim();
const branchId = String(process.env.BRANCH_ID || "").trim();
const expectedVersion = String(process.env.EXPECTED_APP_VERSION || "").trim();
const publicOnly = /^true$/i.test(process.env.VERIFY_PUBLIC_ONLY || "");

const isPrivateHostname = (hostname) => {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^(10|127|169\.254|192\.168)\./.test(host)) return true;
  const private172 = host.match(/^172\.(\d{1,3})\./);
  if (private172 && Number(private172[1]) >= 16 && Number(private172[1]) <= 31) return true;
  if (/^(fc|fd|fe80:)/i.test(host)) return true;
  const ipType = net.isIP(host);
  return ipType === 4 && host.startsWith("0.");
};

const validateCloudUrl = () => {
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error("CLOUD_API_URL must be a valid public HTTPS URL.");
  }
  if (parsed.protocol !== "https:") throw new Error("CLOUD_API_URL must use HTTPS.");
  if (isPrivateHostname(parsed.hostname)) throw new Error("CLOUD_API_URL cannot use localhost, loopback, LAN, link-local, or private IP hosts.");
  if (parsed.port === "5000") throw new Error("Port 5000 is reserved for local/LAN FroozERP and is not accepted as real cloud.");
};

const getJson = async (path) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: "application/json", "Cache-Control": "no-store" },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}: ${body.message || "request failed"}`);
    return body;
  } finally {
    clearTimeout(timer);
  }
};

const requireValue = (condition, message) => {
  if (!condition) throw new Error(message);
};

const run = async () => {
  validateCloudUrl();
  if (!publicOnly) {
    requireValue(verifyUserId && deviceId && branchId, "VERIFY_USER_ID, DEVICE_ID, and BRANCH_ID are required for full device/branch verification.");
  }

  const health = await getJson("/api/health");
  requireValue(health.status === "ok" && health.app === "FroozERP", "Health endpoint did not identify a healthy FroozERP API.");
  requireValue(health.database === "reachable", "Hosted PostgreSQL is not reachable.");

  const version = await getJson("/api/version");
  requireValue(version.status === "ok" && version.version, "Version endpoint did not return an app version.");
  requireValue(version.version === health.version, "Health and version endpoints report different app versions.");
  if (expectedVersion) requireValue(version.version === expectedVersion, `Hosted version ${version.version} does not match EXPECTED_APP_VERSION ${expectedVersion}.`);

  const readiness = await getJson("/api/cloud/readiness");
  requireValue(readiness.cloud_ready === true && readiness.readiness === "deployment_ready", `Cloud deployment is not ready: ${(readiness.blockers || []).join(", ") || "unknown blocker"}.`);

  const result = {
    cloudApiUrl: baseUrl,
    version: version.version,
    health: "passed",
    cloudReadiness: "passed",
    deviceIdentity: publicOnly ? "skipped" : "pending",
    branchStatus: publicOnly ? "skipped" : "pending",
  };

  if (!publicOnly) {
    const query = new URLSearchParams({ user_id: verifyUserId, device_id: deviceId, branch_id: branchId });
    const identity = await getJson(`/api/device/identity?${query}`);
    requireValue(identity.status === "ok" && identity.registration_status === "APPROVED", "Device identity is not approved.");
    requireValue(String(identity.branch_id) === branchId, "Device identity returned the wrong branch.");
    result.deviceIdentity = "passed";

    const branch = await getJson(`/api/branch/status?${query}`);
    requireValue(branch.status === "ok" && branch.branch_active === true, "Branch status is not active.");
    requireValue(String(branch.branch_id) === branchId, "Branch status returned the wrong branch.");
    result.branchStatus = "passed";
  }

  console.log(JSON.stringify(result, null, 2));
};

run().catch((error) => {
  console.error(`FroozERP hosted cloud verification failed: ${error.message}`);
  process.exitCode = 1;
});
