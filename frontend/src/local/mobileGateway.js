/**
 * The phone app's stand-in for the desktop gateway.
 *
 * ## Why this exists
 *
 * On Windows the app never talks to the cloud itself. Every request it makes to its "local API"
 * goes to `backend/desktopGateway.js` on 127.0.0.1, which answers a handful of routes itself
 * (health, version, compatibility, the Owner's internet kill switch, `/settings` while Local Only
 * is on) and proxies everything else to the cloud -- *after* reading the kill switch, and writing
 * an audit line either way. That process boundary is what makes LOCAL_ONLY hold on the desktop:
 * `blocked=true`, `reachedCloud=false`, no external connection.
 *
 * A Tauri phone app has no Node sidecar, so there is no process to put in the middle. This module
 * is the replacement middle. On a phone `LOCAL_API_URL` is the sentinel below -- an address that
 * resolves nowhere -- and the axios adapter (and `fetch` wrapper) built here intercept every request
 * addressed to it:
 *
 *   1. Ask Rust `mobile_gateway_request`. It answers the same routes the gateway answers locally,
 *      with the same status codes and bodies. Anything it answers is the response.
 *   2. Otherwise (404 NOT_A_LOCAL_ROUTE) ask Rust `mobile_gateway_cloud_decision`. It holds the same
 *      policy file and writes the same audit line the gateway writes. A refusal is the response,
 *      and **no network request is made**.
 *   3. Only when Rust says allowed is the URL rewritten onto the cloud base and sent, with path,
 *      query, headers and body unchanged. A transport failure and a 502/503/504 are reported in the
 *      gateway's `CLOUD_UNAVAILABLE` shape (backend/cloudProxyError.js), so the screen reads a
 *      phone with no signal exactly as it reads a laptop with no signal: the cloud is down, the
 *      local service is fine.
 *
 * Every failure of the gateway itself fails closed. A Rust command that throws or answers
 * nonsense never falls through to the network: a broken local answer reads as "the local service
 * did not answer" (the same `Network Error` a dead desktop gateway produces) and a broken or
 * missing decision reads as a refusal.
 *
 * Nothing here touches `window` or `navigator` at import time, and every collaborator (Tauri's
 * `invoke`, the cloud base, the real adapter, the real `fetch`) is passed in, so
 * `mobileGateway.test.mjs` runs all of it under `node --test`.
 */

/** Where the phone app's "local API" lives. Resolves nowhere; only the adapter answers it. */
export const MOBILE_GATEWAY_BASE_URL = "http://froozerp-gateway.local";

export const MOBILE_GATEWAY_LOCAL_COMMAND = "mobile_gateway_request";
export const MOBILE_GATEWAY_DECISION_COMMAND = "mobile_gateway_cloud_decision";
export const MOBILE_RUNTIME_PROFILE_COMMAND = "runtime_profile";

// Word for word backend/cloudProxyError.js. The screen matches on the code, and the message is what
// a person reads, so both must be the gateway's own.
export const CLOUD_UNAVAILABLE_MESSAGE = "FroozERP cloud is temporarily unavailable. Local modules remain available.";
export const CLOUD_NOT_CONFIGURED_MESSAGE = "No cloud backend is configured for this installation. Local modules remain available.";

/**
 * `desktopGateway.js` gives every proxied cloud request `AbortSignal.timeout(15000)` and reports
 * running out of it as CLOUD_UNAVAILABLE. A request that sets no timeout of its own gets the same
 * limit here. A request that does set one keeps it, and its own timeout reaches it as a timeout,
 * exactly as it would on the desktop, where the client gives up before the gateway does.
 */
export const CLOUD_PROXY_TIMEOUT_MS = 15000;

const CLOUD_UNAVAILABLE_STATUSES = new Set([502, 503, 504]);
const JSON_HEADERS = Object.freeze({ "content-type": "application/json; charset=utf-8" });
const NULL_BODY_STATUSES = new Set([204, 205, 304]);
const INSTALLED = Symbol.for("froozerp.mobileGateway.installed");

export const cloudUnavailablePayload = () => ({
  code: "CLOUD_UNAVAILABLE",
  failure_kind: "CLOUD_UNAVAILABLE",
  cloud_connected: false,
  message: CLOUD_UNAVAILABLE_MESSAGE,
});

export const cloudNotConfiguredPayload = () => ({
  code: "CLOUD_NOT_CONFIGURED",
  failure_kind: "CLOUD_NOT_CONFIGURED",
  cloud_connected: false,
  message: CLOUD_NOT_CONFIGURED_MESSAGE,
});

const decisionFailedPayload = (code, detail) => ({
  code,
  failure_kind: "CLOUD_UNAVAILABLE",
  cloud_connected: false,
  message: `This phone could not confirm that cloud access is allowed, so the request was not sent. ${detail}`.trim(),
});

// ---------------------------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------------------------

export const isTauriShell = (win) => Boolean(win && (win.__TAURI_INTERNALS__ || win.__TAURI__));

/**
 * Is this a Tauri app running on a phone or tablet?
 *
 * Synchronous on purpose: the URL constants in App.jsx are computed at module load, before any
 * `invoke` could answer. `runtime_profile` confirms it afterwards (see
 * `describeRuntimeProfileMismatch`). An iPad in desktop mode reports a Macintosh user agent, and is
 * told apart from a real Mac by having a touch screen.
 */
export const isMobileShell = ({ window: win = globalThis.window, navigator: nav = globalThis.navigator } = {}) => {
  if (!isTauriShell(win)) return false;
  const userAgent = String(nav?.userAgent || "");
  if (/Android|iPhone|iPad|iPod/i.test(userAgent)) return true;
  return /Macintosh/i.test(userAgent) && Number(nav?.maxTouchPoints || 0) > 1;
};

/** The `platform` a device registers with. The desktop keeps the value it has always sent. */
export const resolveDevicePlatform = ({ mobile = false, userAgent = "" } = {}) => {
  if (mobile !== true) return "tauri-windows";
  return /Android/i.test(String(userAgent || "")) ? "tauri-android" : "tauri-ios";
};

/** `resolveDevicePlatform` for the runtime this code is running in. */
export const currentDevicePlatform = (env = {}) => resolveDevicePlatform({
  mobile: isMobileShell(env),
  userAgent: (env.navigator || globalThis.navigator)?.userAgent || "",
});

/**
 * What this shell can do, decided once.
 *
 * Every flag is true exactly where the code it gates ran before the phone app existed, so on the
 * desktop and in a browser each gate reads the same as the check it sits next to. Only
 * `mobileShell` turns anything off.
 *
 *   gatewayProcess        ensure/restart_local_backend_service and the 20-second readiness poll.
 *                         A phone's gateway is Rust inside the app, so there is nothing to start.
 *   localReadinessAttempts how many health checks the readiness wait may make. One on a phone: an
 *                         in-process answer does not become ready by being asked again.
 *   updaterPlugin         @tauri-apps/plugin-updater and plugin-process. Neither exists on mobile,
 *                         and a phone is updated by its store, not by this app.
 *   automaticUpdateSettings the "Automatic Updates" panel in Update Center.
 *   localSpeech           reading the desktop gateway's voice status unprompted when FROST opens
 *                         (it stood behind `isDesktopShell()`): whisper.cpp runs in that gateway only.
 *   liveVoiceControls     the Live voice switch, its setup/install card and always-on start. Off on
 *                         a phone only; text FROST goes to the cloud and is unaffected.
 *   kioskLock             fullscreen lock, Owner Exit and the Device Control settings section.
 *   startupLog            the "Open Startup Log" button (opens a file in a desktop viewer).
 */
export const resolveShellCapabilities = ({ desktopShell = false, mobileShell = false } = {}) => {
  const mobile = mobileShell === true;
  const desktopGatewayShell = desktopShell === true && !mobile;
  return Object.freeze({
    mobile,
    gatewayProcess: !mobile,
    localReadinessAttempts: mobile ? 1 : Number.POSITIVE_INFINITY,
    updaterPlugin: desktopGatewayShell,
    automaticUpdateSettings: !mobile,
    localSpeech: desktopGatewayShell,
    liveVoiceControls: !mobile,
    kioskLock: !mobile,
    startupLog: !mobile,
    // Old-install and shortcut cleanup is a Windows installer concern; a phone has neither.
    installCleanup: !mobile,
  });
};

/** Settings sections that configure something this shell does not have. */
const SECTIONS_NEEDING = Object.freeze({
  "settings/device-control": "kioskLock",
});

export const shellShowsSettingsSection = (sectionId, capabilities) => {
  const capability = SECTIONS_NEEDING[sectionId];
  return !capability || capabilities?.[capability] !== false;
};

/**
 * `runtime_profile` is Rust's own statement of where it is running. The sync guess above decided
 * the URLs before Rust could be asked; if the two disagree, say so on the record.
 */
export const describeRuntimeProfileMismatch = (profile, { mobileShell = false } = {}) => {
  if (!profile || typeof profile !== "object" || typeof profile.mobile !== "boolean") {
    return "runtime_profile did not report whether this is a mobile build.";
  }
  if (profile.mobile !== (mobileShell === true)) {
    return `The app detected a ${mobileShell ? "mobile" : "desktop"} shell, but Rust reports platform "${profile.platform || "unknown"}" with mobile=${profile.mobile}.`;
  }
  if (profile.mobile === true && profile.gateway === true) {
    return "Rust reports a mobile build that also started a desktop gateway.";
  }
  return "";
};

// ---------------------------------------------------------------------------------------------
// URL and request shape helpers
// ---------------------------------------------------------------------------------------------

const normalizeBase = (value) => String(value || "").trim().replace(/\/+$/, "");

const isAbsoluteUrl = (value) => /^[a-z][a-z\d+\-.]*:\/\//i.test(String(value || ""));

const combineUrl = (baseURL, url) => {
  const relative = String(url || "");
  if (!baseURL || isAbsoluteUrl(relative)) return relative;
  return relative ? `${normalizeBase(baseURL)}/${relative.replace(/^\/+/, "")}` : String(baseURL);
};

/** Does `url` address the phone's local gateway? Only the exact origin counts. */
export const isMobileGatewayUrl = (url, baseUrl = MOBILE_GATEWAY_BASE_URL) => {
  const base = normalizeBase(baseUrl).toLowerCase();
  const candidate = String(url || "");
  if (!base || candidate.slice(0, base.length).toLowerCase() !== base) return false;
  const next = candidate.charAt(base.length);
  return next === "" || next === "/" || next === "?" || next === "#";
};

/**
 * `http://froozerp-gateway.local/api/x?a=1` -> `{ path: "/api/x", query: "a=1", rest: "/api/x?a=1" }`.
 * `query` carries no leading "?" and is "" when there is none; a fragment is dropped, as a browser
 * never sends one.
 */
export const splitMobileGatewayUrl = (url, baseUrl = MOBILE_GATEWAY_BASE_URL) => {
  if (!isMobileGatewayUrl(url, baseUrl)) return null;
  const withoutBase = String(url).slice(normalizeBase(baseUrl).length).split("#")[0];
  const queryAt = withoutBase.indexOf("?");
  const rawPath = queryAt === -1 ? withoutBase : withoutBase.slice(0, queryAt);
  const query = queryAt === -1 ? "" : withoutBase.slice(queryAt + 1);
  const path = rawPath ? (rawPath.startsWith("/") ? rawPath : `/${rawPath}`) : "/";
  return { path, query, rest: query ? `${path}?${query}` : path };
};

const serializeParamValue = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (value !== null && typeof value === "object") return JSON.stringify(value);
  return String(value);
};

/** axios' `params`, serialised the way a local route needs to read them. */
export const serializeParams = (params, paramsSerializer) => {
  if (!params) return "";
  if (typeof paramsSerializer === "function") return String(paramsSerializer(params) || "");
  if (typeof paramsSerializer?.serialize === "function") return String(paramsSerializer.serialize(params) || "");
  if (typeof URLSearchParams !== "undefined" && params instanceof URLSearchParams) return params.toString();
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      value.filter((entry) => entry !== undefined && entry !== null)
        .forEach((entry) => search.append(`${key}[]`, serializeParamValue(entry)));
    } else {
      search.append(key, serializeParamValue(value));
    }
  }
  return search.toString();
};

/** The full URL axios would request: baseURL + url + params. */
export const axiosRequestUrl = (config = {}) => {
  const full = combineUrl(config.baseURL, config.url);
  const query = serializeParams(config.params, config.paramsSerializer);
  if (!query) return full;
  const [beforeHash] = full.split("#");
  return `${beforeHash}${beforeHash.includes("?") ? "&" : "?"}${query}`;
};

const isHeadersLike = (value) => value
  && typeof value.get === "function"
  && typeof value.forEach === "function"
  && typeof value.entries === "function";

/** Any header container (AxiosHeaders, fetch Headers, a pair list, a plain object) as `{ name: "value" }`. */
export const plainHeaders = (headers) => {
  if (!headers) return {};
  let entries;
  if (isHeadersLike(headers)) entries = Array.from(headers.entries());
  else if (Array.isArray(headers)) entries = headers;
  else entries = Object.entries(typeof headers.toJSON === "function" ? headers.toJSON() : headers);
  const result = {};
  for (const [name, value] of entries) {
    if (value === undefined || value === null || value === false) continue;
    result[String(name).toLowerCase()] = Array.isArray(value) ? value.join(", ") : String(value);
  }
  return result;
};

const isPlainJson = (value) => Array.isArray(value)
  || (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);

/**
 * The request body as a JSON value for Rust. axios has already turned an object into a JSON string
 * by the time an adapter sees it, so a string is parsed back. Binary bodies (audio, FormData, Blob)
 * are not sent to Rust: no local route reads one, and a request Rust does not answer keeps its
 * original body on the way to the cloud.
 */
export const jsonBody = (data) => {
  if (data === undefined || data === null || data === "") return null;
  if (typeof data === "string") {
    try {
      return JSON.parse(data);
    } catch {
      return data;
    }
  }
  if (isPlainJson(data)) return data;
  if (typeof data === "number" || typeof data === "boolean") return data;
  return null;
};

// ---------------------------------------------------------------------------------------------
// The router: one decision, shared by the axios adapter and the fetch wrapper
// ---------------------------------------------------------------------------------------------

/** The local gateway did not answer, or answered with something that is not an HTTP answer. */
export class MobileGatewayUnreachableError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = "MobileGatewayUnreachableError";
    this.code = "MOBILE_GATEWAY_UNREACHABLE";
    if (cause !== undefined) this.cause = cause;
  }
}

const isHttpStatus = (value, { min = 200, max = 599 } = {}) => Number.isInteger(value) && value >= min && value <= max;

const isNotALocalRoute = (answer) => answer.status === 404 && answer.body?.code === "NOT_A_LOCAL_ROUTE";

const refusalFromDecision = (decision) => {
  if (!decision || typeof decision !== "object" || typeof decision.allowed !== "boolean") {
    return { status: 503, body: decisionFailedPayload("MOBILE_GATEWAY_DECISION_INVALID", "The decision was unreadable.") };
  }
  const status = isHttpStatus(decision.status, { min: 400 }) ? decision.status : 503;
  const body = decision.body !== null && typeof decision.body === "object"
    ? decision.body
    : decisionFailedPayload("MOBILE_GATEWAY_DECISION_INVALID", "The refusal carried no reason.");
  return { status, body };
};

/**
 * Decide what a request to the local gateway is.
 *
 * Resolves to one of:
 *   { kind: "local",   status, body, headers }   Rust answered it; that is the response.
 *   { kind: "refused", status, body }            Not a local route, and not allowed out.
 *   { kind: "cloud",   url }                     Allowed: send it to `url`.
 * Rejects with MobileGatewayUnreachableError when the local gateway itself did not answer.
 *
 * "cloud" is returned only when the decision said `allowed: true` in so many words and a cloud base
 * is configured. Everything else is a refusal.
 */
export const createMobileGatewayRouter = ({ invoke, cloudBaseUrl = "", baseUrl = MOBILE_GATEWAY_BASE_URL } = {}) => {
  if (typeof invoke !== "function") throw new TypeError("The phone gateway needs Tauri's invoke.");
  const cloudBase = normalizeBase(cloudBaseUrl);
  // `url` is the full address as Rust should see it. `forwardUrl`, when given, is the address to
  // rewrite onto the cloud instead: axios appends `params` itself, so the adapter forwards the URL
  // without them and leaves the params on the config, rather than sending them twice.
  return async ({ method = "GET", url, forwardUrl, headers, body } = {}) => {
    const target = splitMobileGatewayUrl(url, baseUrl);
    if (!target) throw new TypeError(`${url} is not an address on the phone's local gateway.`);
    const forward = forwardUrl === undefined ? target : splitMobileGatewayUrl(forwardUrl, baseUrl);
    if (!forward) throw new TypeError(`${forwardUrl} is not an address on the phone's local gateway.`);
    const verb = String(method || "GET").toUpperCase();
    const headerMap = plainHeaders(headers);

    let answer;
    try {
      answer = await invoke(MOBILE_GATEWAY_LOCAL_COMMAND, {
        request: { method: verb, path: target.path, query: target.query || null, headers: headerMap, body: jsonBody(body) },
      });
    } catch (error) {
      throw new MobileGatewayUnreachableError(`The phone's local gateway did not answer: ${error?.message || String(error)}`, error);
    }
    if (!answer || typeof answer !== "object" || !isHttpStatus(answer.status)) {
      throw new MobileGatewayUnreachableError("The phone's local gateway answered without an HTTP status.");
    }
    if (!isNotALocalRoute(answer)) {
      return {
        kind: "local",
        status: answer.status,
        body: answer.body === undefined ? null : answer.body,
        headers: answer.headers && typeof answer.headers === "object" ? answer.headers : {},
      };
    }

    let decision;
    try {
      decision = await invoke(MOBILE_GATEWAY_DECISION_COMMAND, {
        // The query rides in the path, as the desktop gateway's audit line carries the full URL.
        request: { method: verb, path: target.query ? `${target.path}?${target.query}` : target.path, headers: headerMap },
      });
    } catch (error) {
      return {
        kind: "refused",
        status: 503,
        body: decisionFailedPayload("MOBILE_GATEWAY_DECISION_FAILED", error?.message || String(error)),
      };
    }
    if (decision?.allowed !== true) return { kind: "refused", ...refusalFromDecision(decision) };
    // The desktop gateway checks its cloud address after the policy, and so does this. Rust answers
    // CLOUD_NOT_CONFIGURED itself when it has none; this covers the JavaScript side having none.
    // Send to the cloud Rust audited the request against, so the audit line and the request can
    // never name two different hosts. The page's own address is only a fallback.
    const decidedBase = normalizeBase(decision.cloud_base_url || "") || cloudBase;
    if (!decidedBase) return { kind: "refused", status: 503, body: cloudNotConfiguredPayload() };
    return { kind: "cloud", url: `${decidedBase}${forward.rest}` };
  };
};

// ---------------------------------------------------------------------------------------------
// axios
// ---------------------------------------------------------------------------------------------

export const isCancelError = (error) => Boolean(error)
  && (error.__CANCEL__ === true || error.code === "ERR_CANCELED" || error.name === "CanceledError");

const isTimeoutError = (error) => ["ECONNABORTED", "ETIMEDOUT"].includes(error?.code)
  && /timeout/i.test(String(error?.message || ""));

const makeAxiosError = (AxiosError, message, code, config, response, cause) => {
  const error = typeof AxiosError === "function"
    ? new AxiosError(message, code, config, null, response)
    : Object.assign(new Error(message), {
      name: "AxiosError",
      code,
      config,
      request: null,
      response,
      status: response?.status,
      isAxiosError: true,
    });
  if (cause !== undefined && error.cause === undefined) error.cause = cause;
  return error;
};

const makeCanceledError = (CanceledError, config) => (typeof CanceledError === "function"
  ? new CanceledError(undefined, config, null)
  : Object.assign(new Error("canceled"), { name: "CanceledError", code: "ERR_CANCELED", __CANCEL__: true, config }));

/** Resolve or reject the way axios' own `settle` does. */
const settle = (response, config, AxiosError) => {
  const validate = config?.validateStatus;
  if (!response.status || !validate || validate(response.status)) return response;
  return Promise.reject(makeAxiosError(
    AxiosError,
    `Request failed with status code ${response.status}`,
    response.status >= 500 ? "ERR_BAD_RESPONSE" : "ERR_BAD_REQUEST",
    config,
    response,
  ));
};

/** Honour the request's own timeout and abort signal while Rust is being asked. */
const withRequestLifecycle = (task, { config, AxiosError, CanceledError }) => new Promise((resolve, reject) => {
  const signal = config?.signal;
  if (signal?.aborted) {
    reject(makeCanceledError(CanceledError, config));
    return;
  }
  let timer = null;
  let onAbort = null;
  const finish = (callback) => (value) => {
    if (timer) clearTimeout(timer);
    if (onAbort) signal?.removeEventListener?.("abort", onAbort);
    callback(value);
  };
  onAbort = () => finish(reject)(makeCanceledError(CanceledError, config));
  signal?.addEventListener?.("abort", onAbort, { once: true });
  const timeout = Number(config?.timeout) || 0;
  if (timeout > 0) {
    timer = setTimeout(() => finish(reject)(makeAxiosError(
      AxiosError,
      config.timeoutErrorMessage || `timeout of ${timeout}ms exceeded`,
      "ECONNABORTED",
      config,
    )), timeout);
  }
  Promise.resolve().then(task).then(finish(resolve), finish(reject));
});

/**
 * The axios adapter. Requests that are not addressed to the local gateway go to `defaultAdapter`
 * with their config untouched.
 */
export const createMobileGatewayAdapter = ({
  invoke,
  cloudBaseUrl = "",
  defaultAdapter,
  baseUrl = MOBILE_GATEWAY_BASE_URL,
  buildUrl = axiosRequestUrl,
  AxiosError,
  CanceledError,
} = {}) => {
  if (typeof defaultAdapter !== "function") throw new TypeError("The phone gateway needs the default axios adapter.");
  const route = createMobileGatewayRouter({ invoke, cloudBaseUrl, baseUrl });

  const adapter = async (config) => {
    const pathUrl = combineUrl(config?.baseURL, config?.url);
    if (!isMobileGatewayUrl(pathUrl, baseUrl)) return defaultAdapter(config);

    let outcome;
    try {
      outcome = await withRequestLifecycle(
        () => route({ method: config.method, url: buildUrl(config), forwardUrl: pathUrl, headers: config.headers, body: config.data }),
        { config, AxiosError, CanceledError },
      );
    } catch (error) {
      if (!(error instanceof MobileGatewayUnreachableError)) throw error;
      // What a dead desktop gateway looks like to axios, so the screen says the same thing.
      throw makeAxiosError(AxiosError, `Network Error (${error.message})`, "ERR_NETWORK", config, undefined, error);
    }

    if (outcome.kind !== "cloud") {
      return settle({
        data: outcome.body,
        status: outcome.status,
        statusText: "",
        headers: { ...JSON_HEADERS, ...(outcome.headers || {}) },
        config,
        request: null,
      }, config, AxiosError);
    }

    // Allowed. Same config -- method, headers, body, params, signal, responseType -- on the cloud's
    // address. Status is judged here rather than by the real adapter, so a 502-504 can be rewritten
    // before the caller's validateStatus sees it, as the gateway's proxy() does.
    const clientTimeout = Number(config.timeout) || 0;
    const cloudConfig = {
      ...config,
      baseURL: undefined,
      url: outcome.url,
      timeout: clientTimeout > 0 ? clientTimeout : CLOUD_PROXY_TIMEOUT_MS,
      validateStatus: () => true,
    };
    const unavailable = () => ({
      data: cloudUnavailablePayload(),
      status: 503,
      statusText: "",
      headers: { ...JSON_HEADERS },
      config,
      request: null,
    });
    let response;
    try {
      response = await defaultAdapter(cloudConfig);
    } catch (error) {
      if (isCancelError(error)) throw error;
      // The caller's own timeout is the caller's to report, as on the desktop.
      if (clientTimeout > 0 && isTimeoutError(error)) throw error;
      if (error?.response && isHttpStatus(error.response.status)) {
        response = error.response;
      } else {
        return settle(unavailable(), config, AxiosError);
      }
    }
    if (CLOUD_UNAVAILABLE_STATUSES.has(response?.status)) return settle(unavailable(), config, AxiosError);
    return settle({ ...response, config }, config, AxiosError);
  };
  adapter[INSTALLED] = true;
  return adapter;
};

// ---------------------------------------------------------------------------------------------
// fetch
// ---------------------------------------------------------------------------------------------

const jsonResponse = (status, body, headers = {}) => new Response(
  NULL_BODY_STATUSES.has(status) || body === undefined ? null : JSON.stringify(body),
  { status, headers: { ...JSON_HEADERS, ...headers } },
);

const requestUrlOf = (input) => {
  if (typeof input === "string") return input;
  if (typeof URL !== "undefined" && input instanceof URL) return input.href;
  return String(input?.url || "");
};

/**
 * `fetch` with the same routing. Anything not addressed to the local gateway goes to `nativeFetch`
 * exactly as it was called.
 */
export const createMobileGatewayFetch = ({ invoke, cloudBaseUrl = "", nativeFetch, baseUrl = MOBILE_GATEWAY_BASE_URL } = {}) => {
  if (typeof nativeFetch !== "function") throw new TypeError("The phone gateway needs the real fetch.");
  const route = createMobileGatewayRouter({ invoke, cloudBaseUrl, baseUrl });

  const gatewayFetch = async (input, init = {}) => {
    const url = requestUrlOf(input);
    if (!isMobileGatewayUrl(url, baseUrl)) return nativeFetch(input, init);
    const request = typeof Request !== "undefined" && input instanceof Request ? input : null;
    const options = init || {};
    const method = String(options.method || request?.method || "GET").toUpperCase();
    const signal = options.signal || request?.signal;
    if (signal?.aborted) throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
    let body = options.body;
    if (body === undefined && request && !["GET", "HEAD"].includes(method)) body = await request.clone().text();

    let outcome;
    try {
      outcome = await route({ method, url, headers: options.headers || request?.headers, body });
    } catch (error) {
      throw new TypeError(`Failed to fetch: ${error?.message || String(error)}`, { cause: error });
    }
    if (outcome.kind !== "cloud") return jsonResponse(outcome.status, outcome.body, outcome.headers);

    const forwarded = request ? new Request(outcome.url, request) : outcome.url;
    let response;
    try {
      response = await nativeFetch(forwarded, options);
    } catch (error) {
      if (error?.name === "AbortError") throw error;
      return jsonResponse(503, cloudUnavailablePayload());
    }
    if (CLOUD_UNAVAILABLE_STATUSES.has(response?.status)) return jsonResponse(503, cloudUnavailablePayload());
    return response;
  };
  gatewayFetch[INSTALLED] = true;
  return gatewayFetch;
};

// ---------------------------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------------------------

/**
 * Put the adapter on axios' defaults and the wrapper on `target.fetch`, once.
 *
 * `mobile` is the only switch. When it is false nothing is touched -- not the adapter, not fetch --
 * so the desktop and the browser run exactly the code they ran before this module existed.
 */
export const installMobileGateway = ({ mobile = false, axios, target = globalThis, invoke, cloudBaseUrl = "", baseUrl = MOBILE_GATEWAY_BASE_URL } = {}) => {
  const installed = { adapter: false, fetch: false };
  if (mobile !== true) return installed;
  if (!axios?.defaults) throw new TypeError("The phone gateway needs the axios instance the app uses.");
  if (!axios.defaults.adapter?.[INSTALLED]) {
    const previous = axios.defaults.adapter;
    axios.defaults.adapter = createMobileGatewayAdapter({
      invoke,
      cloudBaseUrl,
      baseUrl,
      defaultAdapter: (config) => (typeof axios.getAdapter === "function"
        ? axios.getAdapter(previous, config)(config)
        : previous(config)),
      AxiosError: axios.AxiosError,
      CanceledError: axios.CanceledError,
    });
    installed.adapter = true;
  }
  if (typeof target?.fetch === "function" && !target.fetch[INSTALLED]) {
    const nativeFetch = target.fetch.bind(target);
    target.fetch = createMobileGatewayFetch({ invoke, cloudBaseUrl, baseUrl, nativeFetch });
    installed.fetch = true;
  }
  return installed;
};
