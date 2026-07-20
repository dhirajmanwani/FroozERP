const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const test = require("node:test");
const {
  RUNTIME_MODES,
  DesktopSQLiteAdapter,
  MobileSQLiteAdapter,
  WebIndexedDBAdapter,
  createStorageAdapter,
  resolveDesktopSqlitePath,
  resolveRuntimeMode,
} = require("./storageAdapters");

const writeSQLiteFixture = (databasePath) => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const page = Buffer.alloc(4096);
  page.write("SQLite format 3\0", 0, "utf8");
  fs.writeFileSync(databasePath, page);
};

const reservePort = async () => {
  const net = require("node:net");
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

const startDesktopBackend = async ({ databasePath, port, extraEnv = {} }) => {
  const child = spawn(process.execPath, ["desktopGateway.js"], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      APP_VERSION: "clean-install-test",
      APP_MODE: "LOCAL_SINGLE_DEVICE",
      FROOZERP_DEPLOYMENT_TYPE: "local",
      FROOZERP_RUNTIME_MODE: "desktop-local",
      FROOZERP_DESKTOP_SERVICE: "1",
      FROOZERP_SQLITE_PATH: databasePath,
      DATABASE_URL: "postgresql://poisoned:poisoned@127.0.0.1:5432/must_not_connect",
      DB_HOST: "127.0.0.1",
      DB_PORT: "5432",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let spawnError = null;
  child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  child.once("error", (error) => { spawnError = error; });
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return { child, health: await response.json(), logs: () => ({ stdout, stderr }) };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  child.kill();
  throw new Error(`Desktop backend did not become healthy. pid=${child.pid} exit=${child.exitCode} spawn=${spawnError?.message || "none"} stdout=${stdout} stderr=${stderr}`);
};

const stopChild = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

test("desktop runtime is explicit and ignores inherited PostgreSQL configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-desktop-adapter-"));
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const env = {
    FROOZERP_RUNTIME_MODE: "desktop-local",
    FROOZERP_SQLITE_PATH: databasePath,
    DATABASE_URL: "postgresql://wrong@127.0.0.1:5432/wrong",
    DB_HOST: "127.0.0.1",
    DB_PORT: "5432",
  };
  const { runtimeMode, adapter } = createStorageAdapter(env);
  assert.equal(runtimeMode, RUNTIME_MODES.DESKTOP_LOCAL);
  assert.ok(adapter instanceof DesktopSQLiteAdapter);
  assert.equal(adapter.databaseType, "sqlite");
  assert.equal((await adapter.initialize()).reachable, true);
  assert.equal(Object.keys(require.cache).some((entry) => entry.includes(`${path.sep}pg${path.sep}`)), false);
});

test("missing deployment configuration fails safe to desktop-local instead of localhost PostgreSQL", () => {
  assert.equal(resolveRuntimeMode({}), RUNTIME_MODES.DESKTOP_LOCAL);
  assert.equal(resolveRuntimeMode({ DATABASE_URL: "postgresql://wrong@127.0.0.1:5432/wrong" }), RUNTIME_MODES.DESKTOP_LOCAL);
});

test("desktop SQLite path resolves from a clean profile without user configuration", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-default-profile-"));
  const appData = path.join(root, "AppData", "Roaming");
  const env = {
    APPDATA: appData,
    FROOZERP_RUNTIME_MODE: "desktop-local",
    DATABASE_URL: "postgresql://wrong@127.0.0.1:5432/wrong",
  };
  const expected = path.join(appData, "com.srtcompany.froozerp", "froozerp-local.sqlite3");
  assert.equal(resolveDesktopSqlitePath(env), expected);
  const { adapter } = createStorageAdapter(env);
  const health = await adapter.initialize();
  assert.equal(health.databaseType, "sqlite");
  assert.equal(health.databasePath, expected);
  assert.equal(fs.existsSync(expected), true);
});

test("future client adapters remain embedded and PostgreSQL-free", () => {
  const mobile = new MobileSQLiteAdapter();
  const web = new WebIndexedDBAdapter();
  assert.deepEqual([mobile.databaseType, mobile.localFirst], ["sqlite", true]);
  assert.deepEqual([web.databaseType, web.localFirst], ["indexeddb", true]);
});

test("clean desktop first launch and restart reach health without contacting port 5432", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-clean-profile-"));
  const databasePath = path.join(root, "AppData", "Roaming", "com.srtcompany.froozerp", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  for (let launch = 1; launch <= 2; launch += 1) {
    const port = await reservePort();
    const runtime = await startDesktopBackend({ databasePath, port });
    try {
      assert.equal(runtime.health.status, "ok");
      assert.equal(runtime.health.database, "reachable");
      assert.equal(runtime.health.database_type, "sqlite");
      assert.equal(runtime.health.storage_adapter, "desktop-sqlite");
      assert.equal(runtime.health.deployment_type, "local");
      const logs = runtime.logs();
      assert.match(logs.stdout, /Storage adapter: desktop-sqlite/);
      assert.match(logs.stdout, /PostgreSQL client access: blocked/);
      assert.doesNotMatch(`${logs.stdout}\n${logs.stderr}`, /ECONNREFUSED.*5432|127\.0\.0\.1:5432/i);
    } finally {
      await stopChild(runtime.child);
    }
  }
});

test("separate clean device profiles initialize independently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-two-devices-"));
  const first = path.join(root, "device-a", "froozerp-local.sqlite3");
  const second = path.join(root, "device-b", "froozerp-local.sqlite3");
  writeSQLiteFixture(first);
  writeSQLiteFixture(second);
  const firstAdapter = new DesktopSQLiteAdapter({ databasePath: first });
  const secondAdapter = new DesktopSQLiteAdapter({ databasePath: second });
  assert.equal((await firstAdapter.initialize()).reachable, true);
  assert.equal((await secondAdapter.initialize()).reachable, true);
  assert.notEqual(firstAdapter.databasePath, secondAdapter.databasePath);
});

test("desktop App Internet policy can reconnect without allowing ordinary bypasses", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-network-policy-"));
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const cloudPort = await reservePort();
  const cloudMethods = [];
  const cloudServer = require("node:http").createServer((req, res) => {
    cloudMethods.push(`${req.method} ${req.url}`);
    const body = Buffer.from(JSON.stringify({ authenticated: true, is_owner: true, role: "OWNER" }));
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));
  const port = await reservePort();
  const runtime = await startDesktopBackend({
    databasePath,
    port,
    extraEnv: {
      APPDATA: path.join(root, "AppData", "Roaming"),
      CLOUD_API_URL: `http://127.0.0.1:${cloudPort}`,
    },
  });
  try {
    const updatePolicy = (allowInternetAccess) => fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-id": "1" },
      body: JSON.stringify({ allowInternetAccess, user_id: 1 }),
    });
    assert.equal((await updatePolicy(false)).status, 200);
    const blocked = await fetch(`http://127.0.0.1:${port}/api/auth/me?user_id=1`);
    assert.equal(blocked.status, 503);
    assert.equal((await blocked.json()).code, "APP_INTERNET_DISABLED");
    assert.equal((await updatePolicy(true)).status, 200);
    const allowed = await fetch(`http://127.0.0.1:${port}/api/auth/me?user_id=1`);
    assert.equal(allowed.status, 200);
    assert.deepEqual(cloudMethods.slice(0, 2), ["GET /api/auth/me?user_id=1&session_id=", "GET /api/auth/me?user_id=1&session_id="]);
  } finally {
    await stopChild(runtime.child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});

test("desktop gateway converts upstream 502 into a clean cloud unavailable response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-cloud-unavailable-"));
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const cloudPort = await reservePort();
  const cloudServer = require("node:http").createServer((_req, res) => {
    const body = Buffer.from("upstream infrastructure detail");
    res.writeHead(502, { "content-type": "text/plain", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));
  const port = await reservePort();
  const runtime = await startDesktopBackend({
    databasePath,
    port,
    extraEnv: { CLOUD_API_URL: `http://127.0.0.1:${cloudPort}` },
  });
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/ai/briefing`);
    const body = await response.json();
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("access-control-allow-private-network"), "true");
    assert.equal(body.code, "CLOUD_UNAVAILABLE");
    assert.equal(body.cloud_connected, false);
    assert.doesNotMatch(JSON.stringify(body), /upstream infrastructure detail|ENOTFOUND/);
  } finally {
    await stopChild(runtime.child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});
