"use strict";

/**
 * Loads the real Express app and reports, per route, whether an unauthenticated caller can reach
 * the handler. Consumed by `routeAuthCoverage.test.js`, which owns the policy (the public
 * allow-list); this module owns only the mechanism.
 *
 * ## Why the routes are read from the running app
 *
 * The completeness claim A-4 makes — "every route is behind auth" — is only worth anything if the
 * set of routes is the *actual* set. A hand-written list drifts the day someone adds a route and
 * forgets the list, and from then on the suite passes while covering less and less. Regexing
 * `server.js` for `app.get("...")` is barely better: it misses routes registered from
 * `operationalV3.js` and `aiBusinessAssistantService.js` (which between them add ~70 that
 * `server.js` never mentions), it cannot see array paths, and it cannot tell a live registration
 * from one inside a comment or a dead branch. So the app is loaded and `app.router.stack` is read.
 *
 * ## Why protection is measured, not inspected
 *
 * A-4 mounts `requireAuth` app-wide, so the middleware is a stack layer and not attached to any
 * route's own handler chain — walking `route.stack` looking for a named middleware would find
 * nothing and report every route unprotected. Worse, it would keep reporting "protected" for a
 * route whose middleware was mounted but ordered after the handler. What actually matters is
 * behavioural: send a request with no session and see whether the handler runs. That answer is
 * true regardless of how A-4 chooses to mount things.
 *
 * ## Why a forged identity is sent as well as nothing at all
 *
 * Before A-4, several routes already answer 403 to an anonymous request — the FROST routes, the
 * Owner/Admin gates in `/users`. That denial is not authentication: it is a role lookup keyed on
 * the `x-user-id` header, which the caller writes. Treating it as protection would mark ~48 wide
 * open routes as covered. So every route is probed twice, once anonymous and once asserting an
 * identity the way an attacker would, and is only counted protected if *both* are denied with a
 * code that specifically means "no verified session". Any other denial — a role check, a 426, a
 * validation 400 — is not proof and is reported as unprotected.
 *
 * ## Loading `server.js` safely
 *
 * `server.js` has no `module.exports` and, at require time, builds a storage adapter, registers
 * every route, then calls `prepareDatabaseForStartup()` which opens a database, arms a backup
 * timer and binds port 5000. None of that may happen here. Four things are replaced before the
 * require:
 *
 * - **The storage adapter.** Its `initialize`/`query` return a promise that never settles during
 *   startup, so `prepareDatabaseForStartup()` stalls at its first statement and never reaches
 *   `app.listen`, `setInterval`, or the `.catch` that would call `process.exit(1)`. Once the
 *   require returns, later calls reject instead, so a route handler that touches the database
 *   fails fast rather than hanging the probe.
 * - **`app.listen`.** Belt and braces: startup never reaches it, and if that ever changes the
 *   throw is louder than a test process quietly holding a port.
 * - **Network egress.** In desktop-local runtime `server.js` proxies most routes to the hosted
 *   cloud with `fetch`. This harness selects cloud-server runtime, where that middleware is
 *   inert — but an earlier draft of this file did not, and probing routes under desktop-local
 *   sent live requests at the production Railway host. `fetch` and `net.Socket.prototype.connect`
 *   are therefore hard-blocked, so no future edit to the runtime selection can repeat that.
 * - **`child_process.execFile`.** The only spawn in `server.js` is `pg_dump` for backups; nothing
 *   a probe triggers should be able to start a process.
 *
 * The database being a stub is also what keeps the probe honest about business data: no handler
 * gets far enough to read or write a row.
 *
 * ## Cost of this approach
 *
 * It mutates `process.env` and `require.cache` for the whole process, so it is only safe because
 * `node --test` gives each test file its own process. Do not require this module from a test file
 * that also needs a real `server.js`.
 */

const http = require("node:http");
const net = require("node:net");
const path = require("node:path");
const { Duplex } = require("node:stream");

const { AUTH_ERRORS } = require("./authMiddleware");

const SERVER_MODULE = path.join(__dirname, "server.js");

/**
 * Below this, assume the harness failed to load the app rather than that the app shrank.
 *
 * Without this floor the suite's happiest state is also its most useless one: zero routes
 * enumerated means zero unclassified routes, which reads as a pass. The real count is ~284; the
 * bar is deliberately far below that so removing a module does not trip it.
 */
const MINIMUM_EXPECTED_ROUTES = 200;

/**
 * Response codes that mean "you did not present a verified session".
 *
 * Only these count as protection. `AUTH_SESSION_REQUIRED` is what A-4's app-wide `requireAuth`
 * returns; the `DEVICE_SESSION_*` codes come from `deviceSession.js`, which the protocol-v3 and
 * sync routes already verify signatures with. Both are real authentication — a caller cannot
 * produce either outcome's opposite without a token this server signed — so a route defended by
 * either is covered, and A-4 is not forced to re-wrap routes that are already safe.
 *
 * Everything else is excluded on purpose, including 403s that read like security. See the note on
 * forged identity above.
 */
const AUTH_DENIAL_CODES = Object.freeze([
  AUTH_ERRORS.MISSING.code,
  "DEVICE_SESSION_REQUIRED",
  "DEVICE_SESSION_INVALID",
  "DEVICE_SESSION_EXPIRED",
]);

/**
 * The two ways a caller arrives without a session: claiming nothing, and claiming everything.
 *
 * The second is the important one. `x-user-id` is the identity the backend trusts today, so a
 * route that only denies the anonymous probe is not protected — it is asking the attacker to fill
 * in a header.
 */
const PROBES = Object.freeze([
  { name: "anonymous", headers: {} },
  {
    name: "forged-identity",
    headers: { "x-user-id": "1", "x-device-id": "FZDEV-ROUTE-AUTH-COVERAGE" },
  },
]);

/**
 * How long a single probe may take before the route is reported unprotected.
 *
 * A request that never answers has not proved anything, and "could not tell" must not read as
 * "fine". In practice every route answers in single-digit milliseconds because the database stub
 * rejects immediately.
 */
const PROBE_TIMEOUT_MS = 500;

const blockNetworkEgress = () => {
  const refuse = () => {
    throw new Error("routeAuthCoverage: network egress is blocked in this test process");
  };
  globalThis.fetch = async () => refuse();
  net.Socket.prototype.connect = refuse;
  require("node:child_process").execFile = refuse;
};

const configureEnvironment = () => {
  // Cloud-server runtime is both the mode A-4 exists to protect and the only one that serves its
  // own routes: desktop-local forwards almost everything to the hosted cloud instead of handling
  // it, which would tell us nothing about auth.
  process.env.FROOZERP_RUNTIME_MODE = "cloud-server";
  process.env.NODE_ENV = "test";
  // Cloud-server counts as exposed, and `sessionSecret.js` refuses to start an exposed server whose
  // signing key is a borrowed database credential. A dedicated throwaway value satisfies that rule
  // without reading any real secret.
  process.env.DEVICE_SESSION_SECRET = "route-auth-coverage-isolated-signing-key-000000";
  // Pinned so the report does not depend on the developer's shell. In `enforce` the legacy
  // operational routes answer 426 before their handlers run, which would hide whether they are
  // authenticated; `off` is the default and exposes the largest surface, which is the strict case.
  process.env.FROOZERP_OPERATIONAL_SCOPE_MODE = "off";
  // Nothing may resolve to a real hosted origin, whether or not egress is also blocked.
  delete process.env.CLOUD_API_URL;
  delete process.env.FROOZERP_PUBLIC_API_URL;
  delete process.env.APP_MODE;
  delete process.env.FROOZERP_DEPLOYMENT_TYPE;
};

const capturedApps = [];

const stubExpress = () => {
  const expressPath = require.resolve("express");
  const realExpress = require(expressPath);
  const patched = function createApp(...args) {
    const app = realExpress(...args);
    app.listen = () => {
      throw new Error("routeAuthCoverage: app.listen must never run in a test process");
    };
    capturedApps.push(app);
    return app;
  };
  // `express.json`, `express.static` and friends hang off the factory; server.js uses them.
  Object.setPrototypeOf(patched, realExpress);
  for (const key of Object.keys(realExpress)) patched[key] = realExpress[key];
  require.cache[expressPath].exports = patched;
};

let databasePhase = "startup";

/**
 * Statements handlers issued while serving, when recording is switched on.
 *
 * Exists for the tenancy-coverage harness, which asks a different question from this file's: not
 * "did this route demand a session" but "did the SQL it then ran mention the caller's branch". That
 * question can only be answered by looking at the statement, and the statement only exists at all
 * because the adapter is stubbed — so recording belongs here rather than in a second loader that
 * would need its own copy of every safety measure above.
 */
const recordedQueries = [];
let recordingQueries = false;

/** Start recording, and answer queries with empty rows so a handler runs on past its first read. */
const startQueryRecording = () => {
  recordedQueries.length = 0;
  recordingQueries = true;
};

const stopQueryRecording = () => {
  recordingQueries = false;
  return [...recordedQueries];
};

const stubStorageAdapter = () => {
  const storagePath = require.resolve("./storageAdapters");
  const realStorage = require(storagePath);
  const respond = (text, values) => {
    if (databasePhase === "startup") return new Promise(() => {});
    if (recordingQueries) {
      recordedQueries.push(String(typeof text === "object" && text ? text.text : text || ""));
      // Empty rows rather than a rejection: a handler that throws on its first read never issues
      // the second statement, and the second is often the one that carries the scope.
      return Promise.resolve({ rows: [], rowCount: 0 });
    }
    return Promise.reject(new Error("routeAuthCoverage: the database is stubbed out"));
  };
  const adapter = {
    kind: "route-auth-coverage-stub",
    databaseType: "none",
    host: "stub",
    localFirst: false,
    initialize: () => new Promise(() => {}),
    health: respond,
    query: respond,
    connect: respond,
    close: async () => {},
  };
  require.cache[storagePath].exports = {
    ...realStorage,
    createStorageAdapter: () => ({
      runtimeMode: realStorage.RUNTIME_MODES.CLOUD_SERVER,
      adapter,
    }),
  };
};

/**
 * Silence `console` and hand back the restore.
 *
 * Returning a restore function rather than wrapping a callback is what keeps this correct across
 * an `await`: a wrapper's `finally` fires when the callback *returns its promise*, which is before
 * any of the probing has happened, so the noise it exists to suppress would print anyway.
 */
const silenceConsole = () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
  return () => Object.assign(console, saved);
};

let loadedApp = null;

const loadServerApp = () => {
  if (loadedApp) return loadedApp;
  if (require.cache[SERVER_MODULE]) {
    throw new Error("routeAuthCoverage: server.js was already loaded without the test sandbox");
  }
  configureEnvironment();
  blockNetworkEgress();
  stubExpress();
  stubStorageAdapter();
  // server.js logs its whole boot sequence; none of it is signal here.
  const restoreConsole = silenceConsole();
  try {
    require(SERVER_MODULE);
  } finally {
    restoreConsole();
  }
  databasePhase = "serving";
  if (capturedApps.length !== 1) {
    throw new Error(`routeAuthCoverage: expected exactly one Express app, saw ${capturedApps.length}`);
  }
  loadedApp = capturedApps[0];
  return loadedApp;
};

/**
 * Substitute a value for each `:param`, or refuse.
 *
 * Returning `null` for anything this cannot turn into one concrete URL — a RegExp route, an
 * Express wildcard — is the fail-closed half: an unprobeable route is never assumed safe, it is
 * reported as needing an explicit decision.
 */
const probeUrlFor = (routePath) => {
  if (typeof routePath !== "string") return null;
  if (/[*{}()[\]]/.test(routePath)) return null;
  return routePath.replace(/:([A-Za-z0-9_]+)/g, "1");
};

const listRegisteredRoutes = (app) => {
  const routes = [];
  for (const layer of app.router.stack) {
    if (!layer.route) continue;
    // A single registration may carry several paths (`app.put(["/lots/:id", "/inventory-lots/:id"])`).
    const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
    for (const routePath of paths) {
      for (const method of Object.keys(layer.route.methods || {})) {
        const printable = typeof routePath === "string" ? routePath : String(routePath);
        routes.push({
          method: method.toUpperCase(),
          path: printable,
          key: `${method.toUpperCase()} ${printable}`,
          probeUrl: probeUrlFor(routePath),
        });
      }
    }
  }
  return routes;
};

/**
 * Run one request through the app in-process.
 *
 * Real `IncomingMessage`/`ServerResponse` objects over a discard socket, rather than a hand-rolled
 * mock, so middleware that reaches for anything a normal response has still behaves normally.
 * Nothing is bound and nothing leaves the process.
 */
const probe = (app, method, url, headers) => new Promise((resolve) => {
  const socket = new Duplex({ read() {}, write(chunk, encoding, done) { done(); } });
  const req = new http.IncomingMessage(socket);
  req.method = method;
  req.url = url;
  req.headers = { host: "127.0.0.1", ...headers };
  req.httpVersion = "1.1";
  req.httpVersionMajor = 1;
  req.httpVersionMinor = 1;
  req.push(null);

  const res = new http.ServerResponse(req);
  res.assignSocket(socket);
  const chunks = [];
  const write = res.write.bind(res);
  const end = res.end.bind(res);
  res.write = (chunk, ...rest) => {
    if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk));
    return write(chunk, ...rest);
  };
  res.end = (chunk, ...rest) => {
    if (chunk && typeof chunk !== "function") chunks.push(Buffer.from(chunk));
    return end(chunk, ...rest);
  };

  let settled = false;
  const finish = (result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolve(result);
  };
  const timer = setTimeout(() => finish({ status: null, code: null, note: `no response in ${PROBE_TIMEOUT_MS}ms` }), PROBE_TIMEOUT_MS);

  res.on("finish", () => {
    let code = null;
    try {
      code = JSON.parse(Buffer.concat(chunks).toString("utf8")).code ?? null;
    } catch {
      code = null;
    }
    finish({ status: res.statusCode, code, note: null });
  });

  try {
    app(req, res);
  } catch (error) {
    finish({ status: null, code: null, note: `handler threw: ${error.message}` });
  }
});

const describeOutcome = (probeName, result) => {
  if (result.note) return `${probeName}: ${result.note}`;
  return `${probeName}: HTTP ${result.status}${result.code ? ` ${result.code}` : ""}`;
};

/**
 * Classify every registered route.
 *
 * Each entry is `{ method, path, key, probeUrl, authenticated, evidence }`. `authenticated` is
 * true only when every probe was refused with one of `AUTH_DENIAL_CODES`; `evidence` describes
 * what actually came back, so a failure report can say why a route was counted open.
 */
const collectRouteAuthCoverage = async () => {
  const app = loadServerApp();
  const routes = listRegisteredRoutes(app);
  // Every unprotected route reaches a handler that logs the stubbed database rejection; ~200 stack
  // traces would bury the report this function exists to produce.
  const restoreConsole = silenceConsole();
  try {
    const classified = [];
    for (const route of routes) {
      if (!route.probeUrl) {
        classified.push({
          ...route,
          authenticated: false,
          evidence: "not probeable: pattern route has no single concrete URL",
        });
        continue;
      }
      const outcomes = [];
      let authenticated = true;
      for (const { name, headers } of PROBES) {
        const result = await probe(app, route.method, route.probeUrl, headers);
        outcomes.push(describeOutcome(name, result));
        if (!(result.status === 401 && AUTH_DENIAL_CODES.includes(result.code))) authenticated = false;
      }
      classified.push({ ...route, authenticated, evidence: outcomes.join("; ") });
    }
    return classified;
  } finally {
    restoreConsole();
  }
};

module.exports = {
  AUTH_DENIAL_CODES,
  probe,
  startQueryRecording,
  stopQueryRecording,
  MINIMUM_EXPECTED_ROUTES,
  collectRouteAuthCoverage,
  listRegisteredRoutes,
  loadServerApp,
};
