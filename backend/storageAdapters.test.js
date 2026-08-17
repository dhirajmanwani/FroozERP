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

const writePopulatedSQLiteFixture = (databasePath, { malformedSettings = false } = {}) => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const { DatabaseSync } = require("node:sqlite");
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE local_device_identity (
      device_id TEXT PRIMARY KEY,
      branch_id TEXT NOT NULL,
      company_id TEXT,
      registration_status TEXT NOT NULL
    );
    CREATE TABLE local_settings (
      id TEXT PRIMARY KEY,
      branch_id TEXT,
      setting_key TEXT NOT NULL,
      setting_value TEXT NOT NULL,
      deleted_at TEXT
    );
    CREATE TABLE local_products (id TEXT PRIMARY KEY);
    CREATE TABLE local_inventory_lots (id TEXT PRIMARY KEY);
    CREATE TABLE sync_outbox (id TEXT PRIMARY KEY, device_id TEXT, status TEXT);
    INSERT INTO local_device_identity VALUES ('FZDEV-DELL-1781852580596', '1', '1', 'approved');
    INSERT INTO local_settings VALUES ('global-business', NULL, 'businessSettings', '{"business_name":"Global fallback"}', NULL);
    INSERT INTO local_settings VALUES ('branch-business', '1', 'businessSettings', '${malformedSettings ? "{broken" : '{"business_name":"Feel the Freakin Frooz"}'}', NULL);
    INSERT INTO local_settings VALUES ('branch-pos', '1', 'posSettings', '{"allow_negative_stock":false}', NULL);
    INSERT INTO local_settings VALUES ('other-branch', '2', 'paymentSettings', '{"upi_id":"must-not-leak"}', NULL);
  `);
  const insertProduct = database.prepare("INSERT INTO local_products VALUES (?)");
  const insertLot = database.prepare("INSERT INTO local_inventory_lots VALUES (?)");
  const insertOutbox = database.prepare("INSERT INTO sync_outbox VALUES (?, 'FZDEV-DELL-1781852580596', 'synced')");
  for (let id = 1; id <= 25; id += 1) insertProduct.run(String(id));
  for (let id = 1; id <= 70; id += 1) insertLot.run(String(id));
  for (let id = 1; id <= 17; id += 1) insertOutbox.run(String(id));
  database.close();
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

test("loopback PostgreSQL is allowed only for explicitly isolated staging tests", async () => {
  const base = {
    FROOZERP_RUNTIME_MODE: "cloud-server",
    DATABASE_URL: "postgresql://postgres@127.0.0.1:55441/froozerp_current_staging",
  };
  assert.throws(
    () => createStorageAdapter(base),
    /cannot use a loopback host/
  );
  assert.throws(
    () => createStorageAdapter({
      ...base,
      NODE_ENV: "test",
      FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS: "true",
      DATABASE_URL: "postgresql://postgres@127.0.0.1:55441/froozerp_production",
    }),
    /cannot use a loopback host/
  );
  const { adapter } = createStorageAdapter({
    ...base,
    NODE_ENV: "test",
    FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS: "true",
  });
  assert.equal(adapter.host, "127.0.0.1");
  await adapter.pool.end();
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

test("desktop Auto and Local Only policy confirms twenty transitions without cloud leakage", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-network-policy-"));
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const cloudPort = await reservePort();
  const cloudMethods = [];
  const cloudServer = require("node:http").createServer((req, res) => {
    cloudMethods.push(`${req.method} ${req.url}`);
    const body = Buffer.from(JSON.stringify({ status: "ok", server_time: new Date().toISOString(), version: "test" }));
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
      headers: { "content-type": "application/json", "x-user-id": "1", "x-user-role": "OWNER", "x-device-id": "device-test" },
      body: JSON.stringify({ allowInternetAccess, user_id: 1, role: "OWNER", device_id: "device-test" }),
    });
    for (let transition = 0; transition < 20; transition += 1) {
      const allowInternetAccess = transition % 2 === 1;
      const response = await updatePolicy(allowInternetAccess);
      assert.equal(response.status, 200);
      const policy = await response.json();
      assert.equal(policy.status, allowInternetAccess ? "AUTO" : "LOCAL_ONLY");
      // Server-confirmed time is only fetched when the requested mode permits the network.
      assert.equal(policy.timeSource, allowInternetAccess ? "railway" : "device");
      if (!allowInternetAccess) {
        const requestsBeforeBlockedProbe = cloudMethods.length;
        const blocked = await fetch(`http://127.0.0.1:${port}/api/auth/me?user_id=1`);
        assert.equal(blocked.status, 503);
        assert.equal((await blocked.json()).code, "APP_LOCAL_ONLY");
        assert.equal(cloudMethods.length, requestsBeforeBlockedProbe, "Local Only must not reach the cloud server");
      }
    }
    assert.equal((await (await fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`)).json()).status, "AUTO");
  } finally {
    await stopChild(runtime.child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});

test("an unconfigured gateway refuses cloud routing by name instead of defaulting to production", async () => {
  // Disposable profile only: never the real APPDATA directory. No CLOUD_API_URL is supplied,
  // which is exactly how src-tauri/src/lib.rs launches the packaged gateway.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-unconfigured-cloud-"));
  const appData = path.join(root, "AppData", "Roaming");
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  // Internet access is *allowed*: the refusal must come from having no target, not from policy.
  fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: true }));

  const port = await reservePort();
  const runtime = await startDesktopBackend({ databasePath, port, extraEnv: { APPDATA: appData } });
  const auditPath = path.join(appData, "com.srtcompany.froozerp", "logs", "cloud-request-audit.jsonl");
  const readAudit = () => (fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : []);
  try {
    assert.equal(runtime.health.cloud_api_configured, false, "an unconfigured gateway must not report a cloud target");

    const cloudHealth = await (await fetch(`http://127.0.0.1:${port}/api/cloud/health`)).json();
    assert.equal(cloudHealth.cloudApiConfigured, false);
    assert.equal(cloudHealth.cloudReachable, false);
    assert.equal(cloudHealth.errorCode, "CLOUD_NOT_CONFIGURED");
    assert.equal(cloudHealth.configuredCloudBaseUrl, "");

    // A route with no local handler falls through to the cloud proxy.
    const proxied = await fetch(`http://127.0.0.1:${port}/api/sync/pull`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cursor: "0" }),
    });
    assert.equal(proxied.status, 503);
    const payload = await proxied.json();
    assert.equal(payload.code, "CLOUD_NOT_CONFIGURED");
    assert.equal(payload.failure_kind, "CLOUD_NOT_CONFIGURED");
    assert.equal(payload.cloud_connected, false);

    // Switching connectivity must not silently fall through the missing-target probe either.
    const switched = await fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-id": "1", "x-user-role": "OWNER", "x-device-id": "device-test" },
      body: JSON.stringify({ allowInternetAccess: true, user_id: 1, role: "OWNER", device_id: "device-test" }),
    });
    assert.equal((await switched.json()).timeSource, "device");

    const audit = readAudit();
    assert.equal(audit.length > 0, true, "every refusal must be audited, not silently dropped");
    assert.equal(audit.some((entry) => entry.reachedCloud === true), false);
    assert.equal(audit.every((entry) => entry.blocked === true), true);
    assert.equal(audit.some((entry) => entry.reason === "CLOUD_NOT_CONFIGURED"), true);
    assert.equal(/railway|froozerp-production/i.test(JSON.stringify(audit)), false, "no audit entry may name the production host");
  } finally {
    await stopChild(runtime.child);
  }
});

test("switching into Local Only makes no external connection and is audited as blocked", async () => {
  // Disposable profile only: never the real APPDATA directory.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-local-only-switch-"));
  const appData = path.join(root, "AppData", "Roaming");
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: false }));

  // Stand-in for the cloud host. Any hit here is an outbound request the policy should have
  // suppressed; the real production host is never contacted by this suite.
  const cloudPort = await reservePort();
  const cloudRequests = [];
  const cloudServer = require("node:http").createServer((req, res) => {
    cloudRequests.push(`${req.method} ${req.url}`);
    const body = Buffer.from(JSON.stringify({ status: "ok", server_time: new Date().toISOString(), version: "test" }));
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));
  const port = await reservePort();
  const runtime = await startDesktopBackend({
    databasePath,
    port,
    extraEnv: { APPDATA: appData, CLOUD_API_URL: `http://127.0.0.1:${cloudPort}` },
  });
  const auditPath = path.join(appData, "com.srtcompany.froozerp", "logs", "cloud-request-audit.jsonl");
  const readAudit = () => (fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    : []);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-id": "1", "x-user-role": "OWNER", "x-device-id": "device-test" },
      body: JSON.stringify({ allowInternetAccess: false, user_id: 1, role: "OWNER", device_id: "device-test" }),
    });
    assert.equal(response.status, 200);
    const policy = await response.json();
    assert.equal(policy.status, "LOCAL_ONLY");
    assert.equal(policy.allowInternetAccess, false);
    assert.equal(policy.timeSource, "device", "Local Only must fall back to the device clock, not a network probe");
    assert.equal(policy.changedBy, "1");
    assert.equal(policy.deviceId, "device-test");
    assert.ok(Number.isFinite(Date.parse(policy.confirmedAt)));
    assert.equal(JSON.parse(fs.readFileSync(policyPath, "utf8")).allowInternetAccess, false);

    // The invariant itself: external connections at 0 while switching into Local Only.
    assert.deepEqual(cloudRequests, [], "switching into Local Only must attempt no outbound request");

    const audit = readAudit();
    const auditText = JSON.stringify(audit);
    assert.equal(/railway|froozerp-production/i.test(auditText), false, "no audit entry may name the production host");
    assert.equal(audit.some((entry) => entry.reachedCloud === true), false, "no cloud-reaching entry may be recorded");
    const suppressed = audit.filter((entry) => entry.route === "/api/cloud/internet-access");
    assert.deepEqual(
      suppressed.map(({ method, blocked, reachedCloud, reason }) => ({ method, blocked, reachedCloud, reason })),
      [{ method: "PUT", blocked: true, reachedCloud: false, reason: "APP_LOCAL_ONLY" }],
      "the suppressed authoritative-time probe must be audited as blocked"
    );

    // Contrast case: switching back to Auto is authorised by the request itself, so the probe runs.
    const restored = await fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", "x-user-id": "1", "x-user-role": "OWNER", "x-device-id": "device-test" },
      body: JSON.stringify({ allowInternetAccess: true, user_id: 1, role: "OWNER", device_id: "device-test" }),
    });
    assert.equal(restored.status, 200);
    const restoredPolicy = await restored.json();
    assert.equal(restoredPolicy.status, "AUTO");
    assert.equal(restoredPolicy.timeSource, "railway", "returning to Auto must still confirm time against the server");
    assert.deepEqual(cloudRequests, ["GET /api/health"]);
  } finally {
    await stopChild(runtime.child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});

test("packaged desktop Local Only settings stay in SQLite without invoking cloud routing", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-local-settings-policy-"));
  const appData = path.join(root, "AppData", "Roaming");
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writePopulatedSQLiteFixture(databasePath);
  const cloudPort = await reservePort();
  let cloudRequests = 0;
  const cloudServer = require("node:http").createServer((_req, res) => {
    cloudRequests += 1;
    res.writeHead(500).end();
  });
  await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));
  const port = await reservePort();
  const runtime = await startDesktopBackend({
    databasePath,
    port,
    extraEnv: { APPDATA: appData, CLOUD_API_URL: `http://127.0.0.1:${cloudPort}` },
  });
  try {
    const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: false }));
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(`http://127.0.0.1:${port}/settings?device_id=substituted-device`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-froozerp-settings-source"), "local-sqlite");
      assert.equal(response.headers.get("x-froozerp-canonical-device-id"), "FZDEV-DELL-1781852580596");
      const settings = await response.json();
      assert.equal(settings.businessSettings.business_name, "Feel the Freakin Frooz");
      assert.equal(settings.posSettings.allow_negative_stock, false);
      assert.equal(settings.paymentSettings, undefined, "another branch's settings must not leak");
    }
    assert.equal(cloudRequests, 0);
    const { DatabaseSync } = require("node:sqlite");
    const beforeTransition = new DatabaseSync(databasePath, { readOnly: true });
    const settingsBefore = beforeTransition.prepare("SELECT id, branch_id, setting_key, setting_value, deleted_at FROM local_settings ORDER BY id").all();
    beforeTransition.close();
    fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: true }));
    fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: false }));
    const afterTransition = new DatabaseSync(databasePath, { readOnly: true });
    assert.deepEqual(
      afterTransition.prepare("SELECT id, branch_id, setting_key, setting_value, deleted_at FROM local_settings ORDER BY id").all(),
      settingsBefore,
      "Local Only transitions must not replace or erase saved settings"
    );
    const auditPath = path.join(appData, "com.srtcompany.froozerp", "logs", "cloud-request-audit.jsonl");
    const audit = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(audit.length, 3);
    assert.ok(audit.every((entry) => entry.blocked === true && entry.reachedCloud === false && entry.source === "local-sqlite"));
    assert.equal(afterTransition.prepare("SELECT COUNT(*) AS count FROM local_products").get().count, 25);
    assert.equal(afterTransition.prepare("SELECT COUNT(*) AS count FROM local_inventory_lots").get().count, 70);
    assert.deepEqual({ ...afterTransition.prepare("SELECT COUNT(*) AS count, COUNT(DISTINCT device_id) AS devices, MIN(device_id) AS device_id FROM sync_outbox").get() }, {
      count: 17,
      devices: 1,
      device_id: "FZDEV-DELL-1781852580596",
    });
    afterTransition.close();
  } finally {
    await stopChild(runtime.child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});

test("packaged settings fail closed before cloud routing when policy is missing or malformed", async () => {
  for (const policyState of ["missing", "malformed", "invalid-shape"]) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `froozerp-settings-fail-closed-${policyState}-`));
    const appData = path.join(root, "AppData", "Roaming");
    const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
    writePopulatedSQLiteFixture(databasePath);
    const cloudPort = await reservePort();
    let cloudRequests = 0;
    const cloudServer = require("node:http").createServer((_req, res) => {
      cloudRequests += 1;
      res.writeHead(500).end();
    });
    await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));
    const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    if (policyState === "malformed") fs.writeFileSync(policyPath, "{broken");
    if (policyState === "invalid-shape") fs.writeFileSync(policyPath, JSON.stringify({ status: "AUTO" }));
    const port = await reservePort();
    const runtime = await startDesktopBackend({
      databasePath,
      port,
      extraEnv: { APPDATA: appData, CLOUD_API_URL: `http://127.0.0.1:${cloudPort}` },
    });
    try {
      const response = await fetch(`http://127.0.0.1:${port}/settings?device_id=FZDEV-DELL-1781852580596`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-froozerp-settings-source"), "local-sqlite");
      assert.equal(response.headers.get("x-froozerp-canonical-device-id"), "FZDEV-DELL-1781852580596");
      assert.equal(cloudRequests, 0, `${policyState} policy must not invoke the cloud router`);
      const auditPath = path.join(appData, "com.srtcompany.froozerp", "logs", "cloud-request-audit.jsonl");
      const audit = fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).map(JSON.parse);
      assert.deepEqual(audit.map(({ blocked, reachedCloud }) => ({ blocked, reachedCloud })), [
        { blocked: true, reachedCloud: false },
      ]);
      assert.equal(audit[0].route, "/settings?device_id=FZDEV-DELL-1781852580596");
    } finally {
      await stopChild(runtime.child);
      await new Promise((resolve) => cloudServer.close(resolve));
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
});

test("desktop settings use cloud only in Auto and malformed local settings fail without fallback", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-settings-modes-"));
  const appData = path.join(root, "AppData", "Roaming");
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writePopulatedSQLiteFixture(databasePath, { malformedSettings: true });
  const cloudPort = await reservePort();
  let cloudRequests = 0;
  const cloudServer = require("node:http").createServer((_req, res) => {
    cloudRequests += 1;
    const body = Buffer.from(JSON.stringify({ businessSettings: { business_name: "Authorized cloud" } }));
    res.writeHead(200, { "content-type": "application/json", "content-length": body.length });
    res.end(body);
  });
  await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));
  const port = await reservePort();
  const runtime = await startDesktopBackend({ databasePath, port, extraEnv: { APPDATA: appData, CLOUD_API_URL: `http://127.0.0.1:${cloudPort}` } });
  try {
    const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
    fs.mkdirSync(path.dirname(policyPath), { recursive: true });
    fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: false }));
    const malformed = await fetch(`http://127.0.0.1:${port}/settings`);
    assert.equal(malformed.status, 503);
    const failure = await malformed.json();
    assert.equal(failure.code, "LOCAL_SETTINGS_MALFORMED");
    assert.match(failure.message, /preserved/i);
    assert.equal(cloudRequests, 0);
    fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: true }));
    const online = await fetch(`http://127.0.0.1:${port}/settings`);
    assert.equal(online.status, 200);
    assert.equal((await online.json()).businessSettings.business_name, "Authorized cloud");
    assert.equal(cloudRequests, 1);
  } finally {
    await stopChild(runtime.child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});

test("desktop gateway converts upstream 502 into a clean cloud unavailable response", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-cloud-unavailable-"));
  const appData = path.join(root, "AppData", "Roaming");
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeSQLiteFixture(databasePath);
  const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: true }));
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
    extraEnv: {
      APPDATA: appData,
      LOCALAPPDATA: path.join(root, "AppData", "Local"),
      CLOUD_API_URL: `http://127.0.0.1:${cloudPort}`,
    },
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
