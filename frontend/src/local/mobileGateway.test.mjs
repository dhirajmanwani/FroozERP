import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import axios from "axios";

import {
  CLOUD_PROXY_TIMEOUT_MS,
  MOBILE_GATEWAY_BASE_URL,
  MOBILE_GATEWAY_DECISION_COMMAND,
  MOBILE_GATEWAY_LOCAL_COMMAND,
  axiosRequestUrl,
  cloudNotConfiguredPayload,
  cloudUnavailablePayload,
  createMobileGatewayAdapter,
  createMobileGatewayFetch,
  createMobileGatewayRouter,
  currentDevicePlatform,
  describeRuntimeProfileMismatch,
  installMobileGateway,
  isMobileGatewayUrl,
  isMobileShell,
  jsonBody,
  plainHeaders,
  resolveDevicePlatform,
  resolveShellCapabilities,
  shellShowsSettingsSection,
  splitMobileGatewayUrl,
} from "./mobileGateway.js";

const require = createRequire(import.meta.url);
const { normalizeCloudProxyError } = require("../../../backend/cloudProxyError.js");
const GATEWAY_SOURCE = fs.readFileSync(new URL("../../../backend/desktopGateway.js", import.meta.url), "utf8");

const BASE = MOBILE_GATEWAY_BASE_URL;
const CLOUD = "https://cloud.example.test";

const ANDROID_UA = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Mobile Safari/537.36";
const IPHONE_UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";
const IPAD_DESKTOP_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15";
const WINDOWS_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36 Edg/126.0";

const LOCAL_ONLY_BODY = Object.freeze({
  code: "APP_LOCAL_ONLY",
  failure_kind: "CLOUD_UNAVAILABLE",
  cloud_connected: false,
  message: "Local Only mode selected - cloud sync paused. Local modules remain available.",
});

/**
 * A stand-in for Tauri's invoke that plays the Rust side of the contract and records every call.
 * `routes` maps "METHOD /path" to a local answer; everything else is NOT_A_LOCAL_ROUTE.
 */
const fakeRust = ({ routes = {}, decision = { allowed: true, status: 0, body: null }, localThrows = null, decisionThrows = null } = {}) => {
  const calls = [];
  const invoke = async (command, args) => {
    calls.push({ command, args: structuredClone(args) });
    if (command === MOBILE_GATEWAY_LOCAL_COMMAND) {
      if (localThrows) throw localThrows;
      const key = `${args.request.method} ${args.request.path}`;
      const answer = routes[key];
      if (typeof answer === "function") return answer(args.request);
      return answer || { status: 404, body: { code: "NOT_A_LOCAL_ROUTE" } };
    }
    if (command === MOBILE_GATEWAY_DECISION_COMMAND) {
      if (decisionThrows) throw decisionThrows;
      return typeof decision === "function" ? decision(args.request) : decision;
    }
    throw new Error(`unexpected command ${command}`);
  };
  return {
    invoke,
    calls,
    local: () => calls.filter((call) => call.command === MOBILE_GATEWAY_LOCAL_COMMAND),
    decisions: () => calls.filter((call) => call.command === MOBILE_GATEWAY_DECISION_COMMAND),
  };
};

/** The real network, replaced by a recorder. Every call to it is an external connection. */
const fakeNetwork = (respond = () => ({ status: 200, data: "{\"ok\":true}", headers: {} })) => {
  const calls = [];
  const adapter = async (config) => {
    calls.push(config);
    const result = await respond(config);
    return { statusText: "", headers: {}, request: {}, config, ...result };
  };
  return { adapter, calls };
};

/** A real axios instance with the phone gateway as its adapter, so transforms and settle are axios' own. */
const phoneAxios = ({ rust, network, cloudBaseUrl = CLOUD, instance = {} }) => axios.create({
  ...instance,
  adapter: createMobileGatewayAdapter({
    invoke: rust.invoke,
    cloudBaseUrl,
    defaultAdapter: network.adapter,
    AxiosError: axios.AxiosError,
    CanceledError: axios.CanceledError,
  }),
});

const rejectionOf = async (promise) => {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("the request was expected to fail");
  return null;
};

// --- runtime detection --------------------------------------------------------------------------

test("only a Tauri runtime on a phone or tablet is a mobile shell", () => {
  const tauri = { __TAURI_INTERNALS__: {} };
  assert.equal(isMobileShell({ window: tauri, navigator: { userAgent: ANDROID_UA } }), true);
  assert.equal(isMobileShell({ window: { __TAURI__: {} }, navigator: { userAgent: IPHONE_UA } }), true);
  assert.equal(isMobileShell({ window: tauri, navigator: { userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 5 } }), true, "an iPad asking for desktop sites");

  assert.equal(isMobileShell({ window: tauri, navigator: { userAgent: WINDOWS_UA } }), false, "the Windows desktop app");
  assert.equal(isMobileShell({ window: tauri, navigator: { userAgent: IPAD_DESKTOP_UA, maxTouchPoints: 0 } }), false, "a real Mac");
  assert.equal(isMobileShell({ window: {}, navigator: { userAgent: ANDROID_UA } }), false, "a phone browser is not the app");
  assert.equal(isMobileShell({ window: undefined, navigator: undefined }), false);
  assert.equal(isMobileShell(), false, "node has no window at all");
});

test("the desktop keeps registering as tauri-windows; phones say which they are", () => {
  assert.equal(resolveDevicePlatform({ mobile: false, userAgent: WINDOWS_UA }), "tauri-windows");
  assert.equal(resolveDevicePlatform(), "tauri-windows");
  assert.equal(resolveDevicePlatform({ mobile: true, userAgent: ANDROID_UA }), "tauri-android");
  assert.equal(resolveDevicePlatform({ mobile: true, userAgent: IPHONE_UA }), "tauri-ios");
  assert.equal(resolveDevicePlatform({ mobile: true, userAgent: IPAD_DESKTOP_UA }), "tauri-ios");
  assert.equal(currentDevicePlatform({ window: { __TAURI_INTERNALS__: {} }, navigator: { userAgent: ANDROID_UA } }), "tauri-android");
  assert.equal(currentDevicePlatform({ window: { __TAURI_INTERNALS__: {} }, navigator: { userAgent: WINDOWS_UA } }), "tauri-windows");
});

test("shell capabilities change nothing on the desktop or in a browser", () => {
  const desktop = resolveShellCapabilities({ desktopShell: true, mobileShell: false });
  assert.deepEqual({ ...desktop }, {
    mobile: false,
    gatewayProcess: true,
    localReadinessAttempts: Number.POSITIVE_INFINITY,
    updaterPlugin: true,
    automaticUpdateSettings: true,
    localSpeech: true,
    liveVoiceControls: true,
    kioskLock: true,
    startupLog: true,
    installCleanup: true,
  });
  // A browser build never had the updater plugin or the gateway's speech routes; the flags that
  // stand in for `isDesktopShell()` stay false there, and the rest stay as they were.
  const browser = resolveShellCapabilities({ desktopShell: false, mobileShell: false });
  assert.equal(browser.updaterPlugin, false);
  assert.equal(browser.localSpeech, false);
  assert.equal(browser.liveVoiceControls, true, "the browser build keeps its voice switch");
  assert.equal(browser.kioskLock, true);
  assert.equal(browser.automaticUpdateSettings, true);
  assert.equal(browser.gatewayProcess, true);

  const phone = resolveShellCapabilities({ desktopShell: true, mobileShell: true });
  assert.deepEqual({ ...phone }, {
    mobile: true,
    gatewayProcess: false,
    localReadinessAttempts: 1,
    updaterPlugin: false,
    automaticUpdateSettings: false,
    localSpeech: false,
    liveVoiceControls: false,
    kioskLock: false,
    startupLog: false,
    installCleanup: false,
  });
  assert.ok(Object.isFrozen(phone));
});

test("the kiosk settings section is hidden only on a phone", () => {
  const desktop = resolveShellCapabilities({ desktopShell: true });
  const phone = resolveShellCapabilities({ desktopShell: true, mobileShell: true });
  assert.equal(shellShowsSettingsSection("settings/device-control", desktop), true);
  assert.equal(shellShowsSettingsSection("settings/device-control", resolveShellCapabilities()), true, "browser");
  assert.equal(shellShowsSettingsSection("settings/device-control", phone), false);
  assert.equal(shellShowsSettingsSection("settings/updates", phone), true, "Update Center stays; only its automatic part goes");
  assert.equal(shellShowsSettingsSection("settings/sync", phone), true);
});

test("runtime_profile disagreeing with the synchronous guess is reported, agreement is silent", () => {
  assert.equal(describeRuntimeProfileMismatch({ platform: "android", mobile: true, gateway: false }, { mobileShell: true }), "");
  assert.equal(describeRuntimeProfileMismatch({ platform: "windows", mobile: false, gateway: true }, { mobileShell: false }), "");
  assert.match(describeRuntimeProfileMismatch({ platform: "windows", mobile: false, gateway: true }, { mobileShell: true }), /windows/);
  assert.match(describeRuntimeProfileMismatch({ platform: "android", mobile: true, gateway: true }, { mobileShell: true }), /desktop gateway/);
  assert.notEqual(describeRuntimeProfileMismatch(null, { mobileShell: true }), "");
  assert.notEqual(describeRuntimeProfileMismatch({ platform: "android" }, { mobileShell: true }), "");
});

// --- URL helpers --------------------------------------------------------------------------------

test("only the sentinel origin itself is the gateway", () => {
  assert.equal(isMobileGatewayUrl(BASE), true);
  assert.equal(isMobileGatewayUrl(`${BASE}/api/health`), true);
  assert.equal(isMobileGatewayUrl(`${BASE}?x=1`), true);
  assert.equal(isMobileGatewayUrl("HTTP://FROOZERP-GATEWAY.LOCAL/login"), true);
  assert.equal(isMobileGatewayUrl(`${BASE}.evil.example/api/health`), false, "a lookalike host is not the gateway");
  assert.equal(isMobileGatewayUrl(`${BASE}:8080/api/health`), false);
  assert.equal(isMobileGatewayUrl("http://127.0.0.1:5000/api/health"), false);
  assert.equal(isMobileGatewayUrl(`${CLOUD}/api/health`), false);
  assert.equal(isMobileGatewayUrl(""), false);

  assert.deepEqual(splitMobileGatewayUrl(`${BASE}/api/x?a=1&b=2#frag`), { path: "/api/x", query: "a=1&b=2", rest: "/api/x?a=1&b=2" });
  assert.deepEqual(splitMobileGatewayUrl(BASE), { path: "/", query: "", rest: "/" });
  assert.equal(splitMobileGatewayUrl(`${CLOUD}/x`), null);
});

test("request pieces are normalised the way Rust receives them", () => {
  assert.equal(axiosRequestUrl({ baseURL: `${BASE}/`, url: "/api/x", params: { t: 5, skip: undefined, none: null } }), `${BASE}/api/x?t=5`);
  assert.equal(axiosRequestUrl({ url: `${BASE}/api/x?a=1`, params: { b: 2 } }), `${BASE}/api/x?a=1&b=2`);
  assert.equal(axiosRequestUrl({ url: `${BASE}/api/x`, params: { b: 2 }, paramsSerializer: () => "custom=1" }), `${BASE}/api/x?custom=1`);
  assert.equal(axiosRequestUrl({ baseURL: CLOUD, url: `${BASE}/login` }), `${BASE}/login`, "an absolute url wins over baseURL");

  assert.deepEqual(plainHeaders({ Authorization: "Bearer t", "X-User-Id": 7, skip: undefined }), { authorization: "Bearer t", "x-user-id": "7" });
  assert.deepEqual(plainHeaders(new Headers({ "Content-Type": "application/json" })), { "content-type": "application/json" });
  assert.deepEqual(plainHeaders(axios.AxiosHeaders.from({ "Cache-Control": "no-store" })), { "cache-control": "no-store" });
  assert.deepEqual(plainHeaders(null), {});

  assert.deepEqual(jsonBody("{\"allowInternetAccess\":false}"), { allowInternetAccess: false });
  assert.equal(jsonBody("not json"), "not json");
  assert.equal(jsonBody(undefined), null);
  assert.equal(jsonBody(new Uint8Array([1, 2, 3])), null, "audio bytes are never shipped to Rust");
  assert.deepEqual(jsonBody([1, 2]), [1, 2]);
});

// --- the gateway's own shapes -------------------------------------------------------------------

test("CLOUD_UNAVAILABLE and CLOUD_NOT_CONFIGURED are the gateway's own bodies, word for word", () => {
  for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT"]) {
    const normalized = normalizeCloudProxyError({ code });
    assert.equal(normalized.status, 503);
    assert.deepEqual(normalized.payload, cloudUnavailablePayload(), code);
  }
  assert.deepEqual(normalizeCloudProxyError({ code: "CLOUD_NOT_CONFIGURED" }).payload, cloudNotConfiguredPayload());
  // proxy() in desktopGateway.js is what turns a cloud 502-504 into a 503; if it ever stops doing
  // that, or changes the cloud timeout, this module has to follow.
  assert.match(GATEWAY_SOURCE, /if \(\[502, 503, 504\]\.includes\(response\.status\)\) \{\s*return sendJson\(res, 503, \{\s*code: "CLOUD_UNAVAILABLE"/);
  assert.match(GATEWAY_SOURCE, new RegExp(`AbortSignal\\.timeout\\(${CLOUD_PROXY_TIMEOUT_MS}\\)`));
});

// --- local routes -------------------------------------------------------------------------------

test("a local route is answered by mobile_gateway_request and never reaches the network", async () => {
  const rust = fakeRust({
    routes: {
      "GET /api/health": { status: 200, body: { status: "ok", storage: "sqlite" } },
      "GET /api/cloud/internet-access": { status: 200, body: { allowInternetAccess: true, status: "AUTO" } },
    },
  });
  const network = fakeNetwork();
  const client = phoneAxios({ rust, network });

  const health = await client.get(`${BASE}/api/health`, { params: { t: 42 }, headers: { "Cache-Control": "no-cache" } });
  assert.equal(health.status, 200);
  assert.deepEqual(health.data, { status: "ok", storage: "sqlite" });

  const policy = await client.get(`${BASE}/api/cloud/internet-access`);
  assert.deepEqual(policy.data, { allowInternetAccess: true, status: "AUTO" });

  assert.equal(network.calls.length, 0, "no external connection");
  assert.equal(rust.decisions().length, 0, "a local answer never asks for a cloud decision");
  const [first] = rust.local();
  assert.deepEqual(first.args, {
    request: {
      method: "GET",
      path: "/api/health",
      query: "t=42",
      headers: { ...first.args.request.headers },
      body: null,
    },
  });
  assert.equal(first.args.request.headers["cache-control"], "no-cache");
  assert.equal(rust.local()[1].args.request.query, null, "no query is sent as null");
});

test("a local refusal rejects like an HTTP error, with the body intact and no network", async () => {
  const refusal = { code: "OWNER_REQUIRED", message: "Only the Owner can change cloud access." };
  const rust = fakeRust({
    routes: { "PUT /api/cloud/internet-access": (request) => ({ status: 403, body: { ...refusal, echoed: request.body } }) },
  });
  const network = fakeNetwork();
  const client = phoneAxios({ rust, network });

  const error = await rejectionOf(client.put(`${BASE}/api/cloud/internet-access`, { allowInternetAccess: true, user_id: "u-1" }));
  assert.equal(axios.isAxiosError(error), true);
  assert.equal(error.response.status, 403);
  assert.deepEqual(error.response.data, { ...refusal, echoed: { allowInternetAccess: true, user_id: "u-1" } }, "Rust got the JSON body back as JSON");
  assert.equal(error.code, "ERR_BAD_REQUEST");
  assert.equal(network.calls.length, 0);
  assert.equal(rust.decisions().length, 0);
});

test("local speech routes get the phone's 501 and never reach the network", async () => {
  const rust = fakeRust({
    routes: {
      "POST /api/local/speech/transcribe": {
        status: 501,
        body: { code: "NOT_AVAILABLE_ON_THIS_DEVICE", message: "Voice is not available in the phone app." },
      },
    },
  });
  const network = fakeNetwork();
  const client = phoneAxios({ rust, network });
  const error = await rejectionOf(client.post(`${BASE}/api/local/speech/transcribe`, new Uint8Array([1, 2, 3]), { headers: { "Content-Type": "audio/wav" } }));
  assert.equal(error.response.status, 501);
  assert.equal(error.response.data.code, "NOT_AVAILABLE_ON_THIS_DEVICE");
  assert.equal(rust.local()[0].args.request.body, null, "the audio is not shipped to Rust");
  assert.equal(network.calls.length, 0);
});

// --- LOCAL_ONLY ---------------------------------------------------------------------------------

test("LOCAL_ONLY: every cloud-bound request is refused with the decision's status and body, and the network is never touched", async () => {
  const rust = fakeRust({ decision: { allowed: false, status: 503, body: LOCAL_ONLY_BODY } });
  const network = fakeNetwork();
  const client = phoneAxios({ rust, network });

  const attempts = [
    () => client.post(`${BASE}/login`, { username: "owner", password: "x" }),
    () => client.get(`${BASE}/settings/device-control`),
    () => client.post(`${BASE}/api/auth/device-bootstrap-status`, { device_id: "d-1" }),
    () => client.get(`${BASE}/api/v3/products`, { params: { branch_id: 1 } }),
    () => client.put(`${BASE}/api/ai/settings`, { frost: {} }),
    () => client.delete(`${BASE}/api/v3/whatever/9`),
    () => client.post(`${BASE}/api/cloud/device/register`, { platform: "tauri-android" }),
  ];
  for (const attempt of attempts) {
    const error = await rejectionOf(attempt());
    assert.equal(error.response.status, 503);
    assert.deepEqual(error.response.data, LOCAL_ONLY_BODY);
  }
  // A caller that accepts every status still gets the refusal, not a cloud answer.
  const lenient = await client.get(`${BASE}/api/sync/pull`, { validateStatus: () => true });
  assert.equal(lenient.status, 503);
  assert.deepEqual(lenient.data, LOCAL_ONLY_BODY);

  assert.equal(network.calls.length, 0, "external connections: 0");
  assert.equal(rust.decisions().length, attempts.length + 1, "Rust decided (and audited) every one of them");
  assert.deepEqual(rust.decisions()[0].args.request.method, "POST");
  assert.deepEqual(rust.decisions()[0].args.request.path, "/login");
  assert.deepEqual(rust.decisions()[3].args.request.path, "/api/v3/products?branch_id=1", "the decision audits the full address, as the gateway does");
});

test("the decision's own status is kept, whatever it is", async () => {
  const notConfigured = { code: "CLOUD_NOT_CONFIGURED", failure_kind: "CLOUD_NOT_CONFIGURED", cloud_connected: false, message: "x" };
  const rust = fakeRust({ decision: { allowed: false, status: 409, body: notConfigured } });
  const network = fakeNetwork();
  const error = await rejectionOf(phoneAxios({ rust, network }).get(`${BASE}/api/v3/x`));
  assert.equal(error.response.status, 409);
  assert.deepEqual(error.response.data, notConfigured);
  assert.equal(network.calls.length, 0);
});

test("fail closed: a decision that is missing, malformed or throws is a refusal, never a request", async () => {
  const decisions = [
    { decisionThrows: new Error("command mobile_gateway_cloud_decision not found") },
    { decision: null },
    { decision: () => undefined },
    { decision: { allowed: "true", status: 0, body: null } },
    { decision: { allowed: 1 } },
    { decision: { status: 200, body: { ok: true } } },
    { decision: { allowed: false } },
    { decision: { allowed: false, status: 200, body: "nope" } },
  ];
  for (const options of decisions) {
    const rust = fakeRust(options);
    const network = fakeNetwork();
    const error = await rejectionOf(phoneAxios({ rust, network }).post(`${BASE}/login`, { username: "u" }));
    assert.ok(error.response, JSON.stringify(options));
    assert.ok(error.response.status >= 400, "a refusal is never a success");
    assert.equal(error.response.data.cloud_connected, false);
    assert.equal(network.calls.length, 0, `no network for ${JSON.stringify(options)}`);
  }
});

test("fail closed: a local gateway that throws or answers nonsense is 'Network Error', not a cloud request", async () => {
  for (const options of [
    { localThrows: new Error("command mobile_gateway_request not found") },
    { routes: { "GET /api/health": { body: { status: "ok" } } } },
    { routes: { "GET /api/health": { status: "200", body: {} } } },
    { routes: { "GET /api/health": { status: 99, body: {} } } },
    { routes: { "GET /api/health": null } },
  ]) {
    // `null` above falls back to NOT_A_LOCAL_ROUTE in the fake; exercise real nonsense instead.
    const rust = options.routes?.["GET /api/health"] === null
      ? { ...fakeRust(), invoke: async () => null }
      : fakeRust(options);
    const network = fakeNetwork();
    const error = await rejectionOf(phoneAxios({ rust, network }).get(`${BASE}/api/health`));
    assert.equal(error.code, "ERR_NETWORK");
    assert.equal(error.response, undefined, "no response, exactly like a dead desktop gateway");
    assert.match(error.message, /^Network Error/, "connectivityService classifies on this word");
    assert.equal(network.calls.length, 0);
  }
});

// --- allowed ------------------------------------------------------------------------------------

test("allowed: the request is rewritten onto the cloud with path, query, headers and body intact", async () => {
  const rust = fakeRust();
  const network = fakeNetwork(() => ({ status: 200, data: "{\"id\":\"u-1\",\"role\":\"OWNER\"}" }));
  const client = phoneAxios({ rust, network });

  const response = await client.post(
    `${BASE}/login?from=phone`,
    { username: "owner", password: "secret" },
    { params: { t: 7 }, headers: { Authorization: "Bearer abc", "x-device-id": "d-1" }, timeout: 12000 },
  );
  assert.equal(response.status, 200);
  assert.deepEqual(response.data, { id: "u-1", role: "OWNER" }, "axios' own transformResponse still runs");

  assert.equal(network.calls.length, 1);
  const [sent] = network.calls;
  assert.equal(sent.url, `${CLOUD}/login?from=phone`);
  assert.equal(sent.baseURL, undefined);
  assert.deepEqual(sent.params, { t: 7 }, "params stay for the real adapter to append");
  assert.equal(sent.method, "post");
  assert.equal(sent.headers.get("Authorization"), "Bearer abc");
  assert.equal(sent.headers.get("x-device-id"), "d-1");
  assert.equal(sent.data, JSON.stringify({ username: "owner", password: "secret" }), "the body the app sent, byte for byte");
  assert.equal(sent.timeout, 12000, "the caller's own timeout is kept");

  // Rust saw the request before anything left the phone, with the params in its query.
  assert.equal(rust.local()[0].args.request.query, "from=phone&t=7");
  assert.equal(rust.local().length, 1);
  assert.equal(rust.decisions().length, 1);
  assert.equal(rust.decisions()[0].args.request.headers.authorization, "Bearer abc");
});

test("allowed: the request goes to the cloud Rust audited, not the page's own idea of it", async () => {
  const rust = fakeRust({ decision: { allowed: true, status: 0, body: null, cloud_base_url: "https://rehearsal.example/" } });
  const network = fakeNetwork(() => ({ status: 200, data: "{}" }));
  const client = phoneAxios({ rust, network });

  await client.get(`${BASE}/reports/summary?range=today`);

  assert.equal(network.calls.length, 1);
  assert.equal(network.calls[0].url, "https://rehearsal.example/reports/summary?range=today");
});

test("allowed: a baseURL on the gateway is rewritten too, and binary bodies go out untouched", async () => {
  const rust = fakeRust();
  const network = fakeNetwork(() => ({ status: 201, data: "" }));
  const client = phoneAxios({ rust, network, instance: { baseURL: BASE } });
  const bytes = new Uint8Array([9, 8, 7]);
  await client.post("/api/v3/photos", bytes, { headers: { "Content-Type": "application/octet-stream" } });
  assert.equal(network.calls[0].url, `${CLOUD}/api/v3/photos`);
  assert.deepEqual([...new Uint8Array(network.calls[0].data)], [9, 8, 7], "what axios made of the bytes, unchanged");
});

test("allowed: a cloud 4xx or 500 is the cloud's answer, unchanged", async () => {
  for (const [status, body] of [[401, { code: "SESSION_EXPIRED" }], [500, { error: "boom" }], [404, { code: "NOT_FOUND" }]]) {
    const network = fakeNetwork(() => ({ status, data: JSON.stringify(body) }));
    const error = await rejectionOf(phoneAxios({ rust: fakeRust(), network }).get(`${BASE}/api/v3/x`));
    assert.equal(error.response.status, status);
    assert.deepEqual(error.response.data, body);
    assert.equal(error.config.url, `${BASE}/api/v3/x`, "the error describes the request the app made");
  }
});

test("allowed: a cloud 502, 503 or 504 becomes the gateway's CLOUD_UNAVAILABLE", async () => {
  for (const status of [502, 503, 504]) {
    const network = fakeNetwork(() => ({ status, data: "<html>Bad gateway</html>" }));
    const error = await rejectionOf(phoneAxios({ rust: fakeRust(), network }).get(`${BASE}/api/v3/x`));
    assert.equal(error.response.status, 503, `from ${status}`);
    assert.deepEqual(error.response.data, cloudUnavailablePayload());
  }
});

test("allowed: a network failure becomes the gateway's CLOUD_UNAVAILABLE, not 'local service unreachable'", async () => {
  for (const failure of [
    new axios.AxiosError("Network Error", "ERR_NETWORK"),
    Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" }),
    new axios.AxiosError("Request aborted", "ECONNABORTED"),
  ]) {
    const network = fakeNetwork(() => { throw failure; });
    const error = await rejectionOf(phoneAxios({ rust: fakeRust(), network }).post(`${BASE}/api/sync/push`, { operations: [] }));
    assert.equal(error.response.status, 503);
    assert.deepEqual(error.response.data, cloudUnavailablePayload());
    assert.deepEqual(error.response.data, normalizeCloudProxyError({ code: "ECONNREFUSED" }).payload);
  }
});

test("allowed: the gateway's 15 second limit applies only when the caller set none", async () => {
  const timeout = (config) => { throw new axios.AxiosError(`timeout of ${config.timeout}ms exceeded`, "ECONNABORTED"); };

  const unbounded = fakeNetwork(timeout);
  const mapped = await rejectionOf(phoneAxios({ rust: fakeRust(), network: unbounded }).get(`${BASE}/api/v3/x`));
  assert.equal(unbounded.calls[0].timeout, CLOUD_PROXY_TIMEOUT_MS);
  assert.equal(mapped.response.status, 503, "the gateway's own limit reads as CLOUD_UNAVAILABLE");
  assert.deepEqual(mapped.response.data, cloudUnavailablePayload());

  const bounded = fakeNetwork(timeout);
  const own = await rejectionOf(phoneAxios({ rust: fakeRust(), network: bounded }).get(`${BASE}/api/v3/x`, { timeout: 3000 }));
  assert.equal(own.code, "ECONNABORTED", "the caller's own timeout reaches it as a timeout");
  assert.equal(own.response, undefined);
});

test("allowed: a cancelled request stays cancelled", async () => {
  const network = fakeNetwork(() => { throw new axios.CanceledError(); });
  const error = await rejectionOf(phoneAxios({ rust: fakeRust(), network }).get(`${BASE}/api/v3/x`));
  assert.equal(axios.isCancel(error), true);
});

test("no cloud address on the JavaScript side is CLOUD_NOT_CONFIGURED, with no request", async () => {
  const network = fakeNetwork();
  const error = await rejectionOf(phoneAxios({ rust: fakeRust(), network, cloudBaseUrl: "" }).get(`${BASE}/api/v3/x`));
  assert.equal(error.response.status, 503);
  assert.deepEqual(error.response.data, cloudNotConfiguredPayload());
  assert.equal(network.calls.length, 0);
});

// --- lifecycle of the Rust call -----------------------------------------------------------------

test("an aborted or timed-out local request behaves like one in axios", async () => {
  const controller = new AbortController();
  controller.abort();
  const rust = fakeRust({ routes: { "GET /api/health": { status: 200, body: { status: "ok" } } } });
  const cancelled = await rejectionOf(phoneAxios({ rust, network: fakeNetwork() }).get(`${BASE}/api/health`, { signal: controller.signal }));
  assert.equal(axios.isCancel(cancelled), true);

  const hanging = { ...fakeRust(), invoke: () => new Promise(() => {}) };
  const network = fakeNetwork();
  const timedOut = await rejectionOf(phoneAxios({ rust: hanging, network }).get(`${BASE}/api/health`, { timeout: 20 }));
  assert.equal(timedOut.code, "ECONNABORTED");
  assert.match(timedOut.message, /timeout of 20ms exceeded/);
  assert.equal(network.calls.length, 0);
});

// --- anything else ------------------------------------------------------------------------------

test("a request that is not for the gateway goes to the real adapter untouched, and Rust is not asked", async () => {
  const rust = fakeRust();
  const seen = [];
  const adapter = createMobileGatewayAdapter({ invoke: rust.invoke, cloudBaseUrl: CLOUD, defaultAdapter: async (config) => { seen.push(config); return { status: 200, data: {}, headers: {}, config }; } });
  const config = { url: `${CLOUD}/api/sync/pull`, method: "get", headers: {} };
  await adapter(config);
  await adapter({ url: `${BASE}.evil.example/x`, method: "get", headers: {} });
  assert.equal(seen[0], config, "the very same config object");
  assert.equal(seen.length, 2);
  assert.equal(rust.calls.length, 0);
});

test("the router refuses to be built without its collaborators", () => {
  assert.throws(() => createMobileGatewayRouter({}), /invoke/);
  assert.throws(() => createMobileGatewayAdapter({ invoke: async () => null }), /default axios adapter/);
  assert.throws(() => createMobileGatewayFetch({ invoke: async () => null }), /real fetch/);
});

// --- fetch --------------------------------------------------------------------------------------

const fakeFetch = (respond = () => new Response("{}", { status: 200 })) => {
  const calls = [];
  const fetchImpl = async (input, init) => {
    calls.push({ input, init });
    return respond(input, init);
  };
  return { fetchImpl, calls };
};

test("fetch: local routes answer as a Response, and nothing leaves the phone", async () => {
  const rust = fakeRust({ routes: { "GET /api/version": { status: 200, body: { version: "1.0.74" } } } });
  const native = fakeFetch();
  const gatewayFetch = createMobileGatewayFetch({ invoke: rust.invoke, cloudBaseUrl: CLOUD, nativeFetch: native.fetchImpl });
  const response = await gatewayFetch(`${BASE}/api/version`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { version: "1.0.74" });
  assert.equal(native.calls.length, 0);
});

test("fetch: LOCAL_ONLY answers with the decision and makes no connection", async () => {
  const rust = fakeRust({ decision: { allowed: false, status: 503, body: LOCAL_ONLY_BODY } });
  const native = fakeFetch();
  const gatewayFetch = createMobileGatewayFetch({ invoke: rust.invoke, cloudBaseUrl: CLOUD, nativeFetch: native.fetchImpl });
  const response = await gatewayFetch(`${BASE}/login`, { method: "POST", body: JSON.stringify({ username: "u" }), headers: { "Content-Type": "application/json" } });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), LOCAL_ONLY_BODY);
  assert.equal(native.calls.length, 0);
  assert.deepEqual(rust.local()[0].args.request.body, { username: "u" });
});

test("fetch: allowed requests are rewritten with method, headers and body intact", async () => {
  const native = fakeFetch(() => new Response("{\"ok\":true}", { status: 200 }));
  const gatewayFetch = createMobileGatewayFetch({ invoke: fakeRust().invoke, cloudBaseUrl: CLOUD, nativeFetch: native.fetchImpl });
  const init = { method: "PUT", headers: { Authorization: "Bearer t" }, body: "{\"a\":1}" };
  const response = await gatewayFetch(`${BASE}/api/v3/x?y=2`, init);
  assert.equal(response.status, 200);
  assert.equal(native.calls[0].input, `${CLOUD}/api/v3/x?y=2`);
  assert.equal(native.calls[0].init, init);

  const request = new Request(`${BASE}/api/v3/r`, { method: "POST", headers: { "x-device-id": "d-1" }, body: "{\"b\":2}" });
  await gatewayFetch(request);
  const forwarded = native.calls[1].input;
  assert.equal(forwarded.url, `${CLOUD}/api/v3/r`);
  assert.equal(forwarded.method, "POST");
  assert.equal(forwarded.headers.get("x-device-id"), "d-1");
  assert.equal(await forwarded.text(), "{\"b\":2}");
});

test("fetch: network failure and 502-504 are CLOUD_UNAVAILABLE; an abort stays an abort", async () => {
  const offline = createMobileGatewayFetch({ invoke: fakeRust().invoke, cloudBaseUrl: CLOUD, nativeFetch: async () => { throw new TypeError("Failed to fetch"); } });
  const down = await offline(`${BASE}/api/v3/x`);
  assert.equal(down.status, 503);
  assert.deepEqual(await down.json(), cloudUnavailablePayload());

  const badGateway = createMobileGatewayFetch({ invoke: fakeRust().invoke, cloudBaseUrl: CLOUD, nativeFetch: async () => new Response("bad", { status: 502 }) });
  const mapped = await badGateway(`${BASE}/api/v3/x`);
  assert.equal(mapped.status, 503);
  assert.deepEqual(await mapped.json(), cloudUnavailablePayload());

  const abort = new DOMException("aborted", "AbortError");
  const aborting = createMobileGatewayFetch({ invoke: fakeRust().invoke, cloudBaseUrl: CLOUD, nativeFetch: async () => { throw abort; } });
  await assert.rejects(aborting(`${BASE}/api/v3/x`), (error) => error === abort);
});

test("fetch: a dead local gateway rejects like a failed fetch and never falls through", async () => {
  const native = fakeFetch();
  const gatewayFetch = createMobileGatewayFetch({ invoke: fakeRust({ localThrows: new Error("gone") }).invoke, cloudBaseUrl: CLOUD, nativeFetch: native.fetchImpl });
  await assert.rejects(gatewayFetch(`${BASE}/api/health`), TypeError);
  assert.equal(native.calls.length, 0);
});

test("fetch: anything else goes to the real fetch exactly as called", async () => {
  const rust = fakeRust();
  const native = fakeFetch();
  const gatewayFetch = createMobileGatewayFetch({ invoke: rust.invoke, cloudBaseUrl: CLOUD, nativeFetch: native.fetchImpl });
  const init = { mode: "no-cors" };
  await gatewayFetch("https://www.gstatic.com/generate_204", init);
  assert.equal(native.calls[0].input, "https://www.gstatic.com/generate_204");
  assert.equal(native.calls[0].init, init);
  assert.equal(rust.calls.length, 0);
});

// --- installation -------------------------------------------------------------------------------

const fakeAxios = () => {
  const previous = async (config) => ({ status: 200, data: "previous", headers: {}, config });
  return {
    previous,
    defaults: { adapter: previous },
    getAdapter: (adapter) => adapter,
    AxiosError: axios.AxiosError,
    CanceledError: axios.CanceledError,
  };
};

test("off a phone, installation touches nothing at all", () => {
  const client = fakeAxios();
  const nativeFetch = async () => new Response("");
  const target = { fetch: nativeFetch };
  let invoked = 0;
  const result = installMobileGateway({ mobile: false, axios: client, target, invoke: async () => { invoked += 1; }, cloudBaseUrl: CLOUD });
  assert.deepEqual(result, { adapter: false, fetch: false });
  assert.equal(client.defaults.adapter, client.previous);
  assert.equal(target.fetch, nativeFetch);
  assert.equal(invoked, 0);
  assert.deepEqual(installMobileGateway(), { adapter: false, fetch: false }, "no arguments is not a phone");
});

test("on a phone, the adapter and fetch are installed once, before anything else, and routed", async () => {
  const client = fakeAxios();
  const nativeFetch = async () => new Response("native");
  const target = { fetch: nativeFetch };
  const rust = fakeRust({ routes: { "GET /api/health": { status: 200, body: { status: "ok" } } } });

  assert.deepEqual(installMobileGateway({ mobile: true, axios: client, target, invoke: rust.invoke, cloudBaseUrl: CLOUD }), { adapter: true, fetch: true });
  const installedAdapter = client.defaults.adapter;
  const installedFetch = target.fetch;
  assert.notEqual(installedAdapter, client.previous);
  assert.notEqual(installedFetch, nativeFetch);

  // Idempotent: a second call (a hot reload, a second import) does not wrap the wrapper.
  assert.deepEqual(installMobileGateway({ mobile: true, axios: client, target, invoke: rust.invoke, cloudBaseUrl: CLOUD }), { adapter: false, fetch: false });
  assert.equal(client.defaults.adapter, installedAdapter);
  assert.equal(target.fetch, installedFetch);

  const local = await installedAdapter({ url: `${BASE}/api/health`, method: "get", headers: {} });
  assert.deepEqual(local.data, { status: "ok" });
  const passthrough = await installedAdapter({ url: `${CLOUD}/api/sync/pull`, method: "get", headers: {} });
  assert.equal(passthrough.data, "previous", "everything else still goes through the adapter axios had");
  assert.equal(await (await installedFetch("https://example.test/")).text(), "native");
});

test("the real axios module can take the adapter the way App.jsx installs it", async () => {
  const instance = axios.create();
  const shim = {
    defaults: instance.defaults,
    getAdapter: axios.getAdapter,
    AxiosError: axios.AxiosError,
    CanceledError: axios.CanceledError,
  };
  const rust = fakeRust({ routes: { "GET /health": { status: 200, body: { status: "ok" } } } });
  installMobileGateway({ mobile: true, axios: shim, target: {}, invoke: rust.invoke, cloudBaseUrl: CLOUD });
  const response = await instance.get(`${BASE}/health`);
  assert.deepEqual(response.data, { status: "ok" });
});

// --- App.jsx wiring -----------------------------------------------------------------------------
//
// App.jsx cannot be imported under node, so its wiring is checked as text. Each assertion names the
// phone-only behaviour it protects; desktop behaviour is protected by the suites that already assert
// on the lines these sit next to.

const APP = fs.readFileSync(new URL("../App.jsx", import.meta.url), "utf8");
const SYNC = fs.readFileSync(new URL("./syncService.js", import.meta.url), "utf8");
const sliceFrom = (start, end) => APP.slice(APP.indexOf(start), APP.indexOf(end, APP.indexOf(start) + start.length));

test("App.jsx: the phone's local API is the sentinel, and the gateway is installed at module load", () => {
  assert.match(APP, /const MOBILE_SHELL = isMobileShell\(\);/);
  assert.match(APP, /const LOCAL_API_URL = MOBILE_SHELL\s*\n\s*\? MOBILE_GATEWAY_BASE_URL/);
  const install = APP.indexOf("installMobileGateway({ mobile: MOBILE_SHELL, axios, target: window, invoke: invokeTauriCommand, cloudBaseUrl: CLOUD_API_URL });");
  assert.ok(install > 0, "installed with the phone flag, the app's axios, window.fetch, Tauri invoke and the cloud base");
  assert.ok(install > APP.indexOf("const CLOUD_API_URL = "), "after the cloud base exists");
  assert.ok(install > APP.indexOf("const invokeTauriCommand = "), "after invoke exists");
  assert.ok(install < APP.indexOf("function App() {"), "before any component can make a request");
  assert.equal(APP.match(/installMobileGateway\(/g).length, 1, "installed exactly once");
});

test("App.jsx: a phone never starts or polls a local backend process", () => {
  const ensure = sliceFrom("const ensureLocalBackendService = useCallback(", "}, [markLocalServiceHealthy]);");
  const skip = ensure.indexOf("if (!SHELL_CAPABILITIES.gatewayProcess) {");
  assert.ok(skip > 0);
  assert.ok(skip < ensure.indexOf("invokeTauriCommand(command)"), "decided before ensure/restart_local_backend_service is invoked");
  assert.match(ensure.slice(skip), /markLocalServiceHealthy\(service, reason\);\s*return service;/);
  const wait = sliceFrom("const waitForLocalBackendReady = useCallback(", "}, [API_URL]);");
  assert.match(wait, /if \(attempt >= SHELL_CAPABILITIES\.localReadinessAttempts\) break;/);
});

test("App.jsx: the updater and process plugins are unreachable on a phone", () => {
  const runner = APP.slice(APP.indexOf("function AutoUpdateRunner"), APP.indexOf("\nfunction ", APP.indexOf("function AutoUpdateRunner") + 1));
  assert.ok(runner.indexOf("if (!SHELL_CAPABILITIES.updaterPlugin) return undefined;") > 0);
  assert.ok(runner.indexOf("if (!SHELL_CAPABILITIES.updaterPlugin) return undefined;") < runner.indexOf('import("@tauri-apps/plugin-updater")'));
  assert.ok(runner.indexOf("if (!SHELL_CAPABILITIES.updaterPlugin) return;") < runner.indexOf('import("@tauri-apps/plugin-process")'));
  const center = APP.slice(APP.indexOf("function UpdateCenterSection"), APP.indexOf("\nfunction ", APP.indexOf("function UpdateCenterSection") + 1));
  assert.match(center, /const desktopUpdaterAvailable = SHELL_CAPABILITIES\.updaterPlugin;/);
  assert.match(center, /if \(desktopUpdaterAvailable\) \{\s*const \{ check \} = await import\("@tauri-apps\/plugin-updater"\);/);
  const manualInstall = center.slice(center.indexOf("const installAndRestart = async () => {"));
  assert.ok(manualInstall.indexOf("if (!SHELL_CAPABILITIES.updaterPlugin) return;") < manualInstall.indexOf('import("@tauri-apps/plugin-process")'));
  assert.match(center, /\{SHELL_CAPABILITIES\.automaticUpdateSettings && \(\s*<div className="maintenance-cleanup-panel">\s*<strong>Automatic Updates<\/strong>/);
  assert.equal((APP.match(/import\("@tauri-apps\/plugin-(updater|process)"\)/g) || []).length, 4, "no new path to either plugin");
  assert.doesNotMatch(APP, /^import .*@tauri-apps\/plugin-(updater|process)/m, "never a static import");
});

test("App.jsx: kiosk, startup log and local voice are off on a phone; text FROST is not touched", () => {
  assert.match(APP, /if \(!SHELL_CAPABILITIES\.kioskLock\) return;\s*invokeTauriCommand\("set_kiosk_mode"/);
  assert.match(APP, /if \(SHELL_CAPABILITIES\.kioskLock\) await invokeTauriCommand\("set_kiosk_mode"/);
  assert.equal((APP.match(/invokeTauriCommand\("set_kiosk_mode"/g) || []).length, 2);
  assert.match(APP, /\{SHELL_CAPABILITIES\.kioskLock && settingsData\.deviceControlSettings\?\.fullscreen_lock_enabled && \(\s*<button className="secondary-button kiosk-exit-button"/);
  assert.match(APP, /shellShowsSettingsSection\(section\.id, SHELL_CAPABILITIES\)/);
  assert.match(APP, /\{SHELL_CAPABILITIES\.startupLog && \(\s*<button className="secondary-button" type="button" onClick=\{openStartupLogFile\}>/);
  assert.match(APP, /const liveVoiceBar = SHELL_CAPABILITIES\.liveVoiceControls && \(\s*<FrostLiveVoiceBar/);
  assert.match(APP, /if \(!SHELL_CAPABILITIES\.liveVoiceControls\) return;\s*const key = String\(user\.id/);
  assert.match(APP, /if \(!frostDrawerOpen \|\| !frostBellAllowed \|\| !SHELL_CAPABILITIES\.localSpeech\) return;\s*readFrostSpeechStatus\(\);/);
});

test("App.jsx and syncService: devices register with the shell's platform, never a hard-coded one", () => {
  assert.doesNotMatch(APP, /"tauri-windows"/);
  assert.doesNotMatch(SYNC, /"tauri-windows"/);
  assert.equal((APP.match(/platform: DEVICE_PLATFORM,/g) || []).length, 2);
  assert.match(APP, /const DEVICE_PLATFORM = currentDevicePlatform\(\);/);
  assert.match(SYNC, /platform: currentDevicePlatform\(\),/);
});
