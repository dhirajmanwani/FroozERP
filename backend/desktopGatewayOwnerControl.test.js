"use strict";

/**
 * Who may move the LOCAL_ONLY kill switch.
 *
 * The property this file exists for is the first test: **two headers must never be enough to
 * re-enable cloud access.** `x-user-id` plus `x-user-role: OWNER` were the entire authority on
 * PUT /api/cloud/internet-access, and this gateway is a separate process from server.js with no
 * session middleware in front of it, so `requireAuth` does not and cannot cover this route.
 *
 * The rest pin the failures that are invisible when they regress:
 *
 *   - a refusal must leave the device *more* locked down, never less, so the lockdown direction
 *     must not acquire a new way to fail;
 *   - a corroboration that cannot be evaluated must not become a lockout;
 *   - and every refused path must still satisfy the CLAUDE.md hard boundary -- blocked=true,
 *     reachedCloud=false, zero cloud-router invocations, zero external connections. The last
 *     test drives a real gateway process against a stand-in cloud host to prove it, because a
 *     unit test cannot observe a socket that should never have been opened.
 *
 * Everything here runs against disposable temp profiles. No real APPDATA, no real database, and
 * the stand-in cloud host is a local counter -- production is never contacted.
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");

const {
  CONTROL_ORIGINS,
  classifyControlOrigin,
  resolveKillSwitchDecision,
} = require("./desktopGateway");

/** A request that is exactly as authoritative as the old code required, and no more. */
const spoofedOwner = (overrides = {}) => ({
  requestedInternetAccess: true,
  userId: "1",
  role: "OWNER",
  deviceId: "FZDEV-TEST-1",
  origin: "",
  localOwnerUserIds: null,
  ...overrides,
});

// ---------------------------------------------------------------------------------------------
// The point of the whole change
// ---------------------------------------------------------------------------------------------

test("a website cannot re-enable cloud access by asserting the Owner headers", () => {
  // Before this change these two headers WERE the authority, and every response from the gateway
  // carries `access-control-allow-origin: *` with private-network access allowed -- so any page
  // the Owner loaded could preflight this route and switch the shop back onto the internet.
  const decision = resolveKillSwitchDecision(spoofedOwner({ origin: "https://attacker.example" }));

  assert.equal(decision.allowed, false, "a foreign origin must not be able to unlock cloud access");
  assert.equal(decision.code, "CROSS_ORIGIN_CONTROL_REFUSED");
  assert.equal(decision.provenance, CONTROL_ORIGINS.FOREIGN_WEBSITE);
});

test("the same website may still lock the device down", () => {
  // Deliberate asymmetry, and the one place where refusing would be the *unsafe* answer: a check
  // that blocked the lockdown direction could leave a device on the internet that its Owner asked
  // to isolate. Forcing LOCAL_ONLY is exactly as possible as it was before this change, it never
  // opens cloud access, and it is the direction the hard boundary wants to succeed.
  const decision = resolveKillSwitchDecision(spoofedOwner({
    requestedInternetAccess: false,
    origin: "https://attacker.example",
  }));

  assert.equal(decision.allowed, true);
  assert.equal(decision.direction, "LOCK_DOWN");
});

test("an opaque origin is a website, not the app", () => {
  // A sandboxed iframe or a file:// page sends `Origin: null`. The desktop shell always presents a
  // real origin, so `null` can only be someone else.
  const decision = resolveKillSwitchDecision(spoofedOwner({ origin: "null" }));

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "CROSS_ORIGIN_CONTROL_REFUSED");
});

// ---------------------------------------------------------------------------------------------
// Origin classification: the app must never be locked out of its own switch
// ---------------------------------------------------------------------------------------------

test("the shipped app's own origins are recognised", () => {
  // These are the origins the Tauri shell presents (the same set backend/server.js allows), plus
  // the dev server. If this ever regresses, an Owner already in LOCAL_ONLY has no way back except
  // hand-editing cloud-network-policy.json.
  for (const origin of [
    "tauri://localhost",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "http://localhost:5173",
    "http://127.0.0.1:5000",
    "http://[::1]:5173",
  ]) {
    assert.equal(classifyControlOrigin(origin), CONTROL_ORIGINS.DESKTOP_APP, origin);
    assert.equal(resolveKillSwitchDecision(spoofedOwner({ origin })).allowed, true, origin);
  }
});

test("an origin form this classifier does not understand is not treated as hostile", () => {
  // The classifier's job is to recognise a website -- always http(s) on a publicly resolvable
  // hostname. A custom scheme the shell might adopt later must not silently become a lockout.
  assert.equal(classifyControlOrigin("froozerp://localhost"), CONTROL_ORIGINS.NOT_A_BROWSER);
  assert.equal(classifyControlOrigin("not a url"), CONTROL_ORIGINS.NOT_A_BROWSER);
});

test("a request with no Origin is reported as what it is: not judgeable", () => {
  // Native callers -- another process on this machine, curl, this test suite -- send no Origin and
  // cannot be distinguished from the app. This is the residual risk, recorded here so it stays
  // visible: nothing this process can hold defends against code already running as the Owner.
  const decision = resolveKillSwitchDecision(spoofedOwner({ origin: "" }));

  assert.equal(decision.provenance, CONTROL_ORIGINS.NOT_A_BROWSER);
  assert.equal(decision.allowed, true);
});

// ---------------------------------------------------------------------------------------------
// The Owner claim itself
// ---------------------------------------------------------------------------------------------

test("an incomplete or non-Owner claim is refused in both directions", () => {
  for (const requestedInternetAccess of [true, false]) {
    for (const missing of [
      { userId: "" },
      { deviceId: "" },
      { role: "" },
      { role: "CASHIER" },
      { role: "MANAGER" },
    ]) {
      const decision = resolveKillSwitchDecision(spoofedOwner({
        requestedInternetAccess,
        origin: "tauri://localhost",
        ...missing,
      }));
      assert.equal(decision.allowed, false, JSON.stringify({ requestedInternetAccess, ...missing }));
      assert.equal(decision.code, "OWNER_REQUIRED");
    }
  }
});

test("when this device knows who its Owners are, the role stops coming from a header", () => {
  // The header says OWNER; the device's own cached profiles say this id is not one. Local data wins.
  const refused = resolveKillSwitchDecision(spoofedOwner({
    origin: "tauri://localhost",
    userId: "9",
    localOwnerUserIds: ["1", "4"],
  }));
  assert.equal(refused.allowed, false);
  assert.equal(refused.code, "OWNER_NOT_RECOGNISED");

  const allowed = resolveKillSwitchDecision(spoofedOwner({
    origin: "tauri://localhost",
    userId: "4",
    localOwnerUserIds: ["1", "4"],
  }));
  assert.equal(allowed.allowed, true);
  assert.equal(allowed.direction, "UNLOCK");
});

test("owner ids are opaque strings and are never coerced to numbers", () => {
  // CLAUDE.md: "004" and 4 are different entities. A Number() on either side of this comparison
  // would hand the switch to the wrong user.
  const decision = resolveKillSwitchDecision(spoofedOwner({
    origin: "tauri://localhost",
    userId: "4",
    localOwnerUserIds: ["004"],
  }));

  assert.equal(decision.allowed, false);
  assert.equal(decision.code, "OWNER_NOT_RECOGNISED");
});

test("a corroboration that cannot be evaluated is skipped, not failed", () => {
  // `null` is what the gateway reports when there is no local database, no cached profile, or an
  // unreadable one. A fresh device has never cached a profile; treating that as a failure would
  // mean it could never leave LOCAL_ONLY at all -- a lockout, not a defence. Same rule, same
  // reason, as frontend/src/local/offlineCredentialSource.js.
  for (const localOwnerUserIds of [null, [], ["", "   "]]) {
    const decision = resolveKillSwitchDecision(spoofedOwner({
      origin: "tauri://localhost",
      localOwnerUserIds,
    }));
    assert.equal(decision.allowed, true, JSON.stringify(localOwnerUserIds));
  }
});

test("the corroboration never blocks the lockdown direction", () => {
  // Locking down must not be refusable by a check whose inputs may be missing.
  const decision = resolveKillSwitchDecision(spoofedOwner({
    requestedInternetAccess: false,
    origin: "tauri://localhost",
    userId: "9",
    localOwnerUserIds: ["1"],
  }));

  assert.equal(decision.allowed, true);
  assert.equal(decision.direction, "LOCK_DOWN");
});

test("no refusal ever returns a policy: refusing cannot be the thing that opens cloud access", () => {
  // Structural guard. The decision carries no `allowInternetAccess`, so a caller cannot mistake a
  // refusal for a policy that permits the network.
  for (const origin of ["https://attacker.example", "null"]) {
    const decision = resolveKillSwitchDecision(spoofedOwner({ origin }));
    assert.equal(decision.allowed, false);
    assert.equal("allowInternetAccess" in decision, false);
    assert.equal(decision.direction, undefined);
  }
});

// ---------------------------------------------------------------------------------------------
// The hard boundary, against a real gateway process
// ---------------------------------------------------------------------------------------------

const reservePort = async () => {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
};

/** Disposable profile: a real SQLite file carrying one cached Owner profile, and nothing else. */
const writeDisposableProfile = (databasePath) => {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE local_kv (key TEXT PRIMARY KEY, value TEXT NOT NULL);");
  database
    .prepare("INSERT INTO local_kv (key, value) VALUES (?, ?)")
    .run("offline_user_profile::FZDEV-TEST-1::owner", JSON.stringify({ id: "1", role: "OWNER" }));
  database
    .prepare("INSERT INTO local_kv (key, value) VALUES (?, ?)")
    .run("offline_user_profile::FZDEV-TEST-1::till", JSON.stringify({ id: "9", role: "CASHIER" }));
  database.close();
};

const startGateway = async ({ databasePath, port, appData, cloudApiUrl }) => {
  const child = spawn(process.execPath, ["desktopGateway.js"], {
    cwd: __dirname,
    windowsHide: true,
    env: {
      ...process.env,
      PORT: String(port),
      APP_VERSION: "kill-switch-test",
      APPDATA: appData,
      FROOZERP_RUNTIME_MODE: "desktop-local",
      FROOZERP_DESKTOP_SERVICE: "1",
      FROOZERP_SQLITE_PATH: databasePath,
      CLOUD_API_URL: cloudApiUrl,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(750) });
      if (response.ok) return child;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  child.kill();
  throw new Error(`Gateway did not become healthy. exit=${child.exitCode} stderr=${stderr}`);
};

const stopGateway = async (child) => {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) => setTimeout(resolve, 5000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
};

test("a refused kill-switch request leaves LOCAL_ONLY intact and touches no network", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "froozerp-kill-switch-"));
  const appData = path.join(root, "AppData", "Roaming");
  const databasePath = path.join(root, "profile", "froozerp-local.sqlite3");
  writeDisposableProfile(databasePath);

  const policyPath = path.join(appData, "com.srtcompany.froozerp", "cloud-network-policy.json");
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  // The device starts in LOCAL_ONLY. Every refusal below has to leave it there.
  fs.writeFileSync(policyPath, JSON.stringify({ allowInternetAccess: false }));

  // Stand-in for the cloud host. Any hit here is an external connection the kill switch should
  // have suppressed; the production host is never named or contacted by this suite.
  const cloudRequests = [];
  const cloudServer = http.createServer((req, res) => {
    cloudRequests.push(`${req.method} ${req.url}`);
    const payload = Buffer.from(JSON.stringify({ status: "ok", server_time: new Date().toISOString(), version: "test" }));
    res.writeHead(200, { "content-type": "application/json", "content-length": payload.length });
    res.end(payload);
  });
  const cloudPort = await reservePort();
  await new Promise((resolve, reject) => cloudServer.listen(cloudPort, "127.0.0.1", resolve).once("error", reject));

  const port = await reservePort();
  const child = await startGateway({ databasePath, port, appData, cloudApiUrl: `http://127.0.0.1:${cloudPort}` });

  const auditPath = path.join(appData, "com.srtcompany.froozerp", "logs", "cloud-request-audit.jsonl");
  const readAudit = () => (fs.existsSync(auditPath)
    ? fs.readFileSync(auditPath, "utf8").trim().split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : []);
  const putPolicy = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`, {
    method: "PUT",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  const currentMode = async () =>
    (await (await fetch(`http://127.0.0.1:${port}/api/cloud/internet-access`)).json()).status;
  const ownerHeaders = { "x-user-id": "1", "x-user-role": "OWNER", "x-device-id": "FZDEV-TEST-1" };

  try {
    // 1. The spoofed website. Refused, and the device stays exactly as blocked as it was.
    const foreign = await putPolicy({ allowInternetAccess: true }, { ...ownerHeaders, origin: "https://attacker.example" });
    assert.equal(foreign.status, 403);
    assert.equal((await foreign.json()).code, "CROSS_ORIGIN_CONTROL_REFUSED");
    assert.equal(JSON.parse(fs.readFileSync(policyPath, "utf8")).allowInternetAccess, false);
    assert.equal(await currentMode(), "LOCAL_ONLY");
    assert.deepEqual(cloudRequests, [], "a refused unlock must attempt no outbound request");

    // 2. A local caller naming a user this device does not know to be an Owner.
    const unknownOwner = await putPolicy(
      { allowInternetAccess: true },
      { ...ownerHeaders, "x-user-id": "9" },
    );
    assert.equal(unknownOwner.status, 403);
    assert.equal((await unknownOwner.json()).code, "OWNER_NOT_RECOGNISED");
    assert.equal(JSON.parse(fs.readFileSync(policyPath, "utf8")).allowInternetAccess, false);
    assert.equal(await currentMode(), "LOCAL_ONLY");
    assert.deepEqual(cloudRequests, []);

    // 3. Locking down from that same untrusted origin still works, and still reaches nothing.
    const lockdown = await putPolicy({ allowInternetAccess: false }, { ...ownerHeaders, origin: "https://attacker.example" });
    assert.equal(lockdown.status, 200);
    assert.equal((await lockdown.json()).status, "LOCAL_ONLY");
    assert.deepEqual(cloudRequests, [], "switching into Local Only must attempt no outbound request");

    // Everything recorded so far is a suppressed attempt: blocked, and reaching nothing.
    const refusals = readAudit();
    assert.ok(refusals.length > 0, "every refusal must be audited, not silently dropped");
    assert.equal(refusals.every((entry) => entry.blocked === true), true);
    assert.equal(refusals.some((entry) => entry.reachedCloud === true), false);
    assert.deepEqual(
      refusals.filter((entry) => entry.source === "kill-switch-authority").map((entry) => entry.reason),
      ["CROSS_ORIGIN_CONTROL_REFUSED", "OWNER_NOT_RECOGNISED"],
    );
    assert.equal(/railway|froozerp-production/i.test(JSON.stringify(refusals)), false, "no audit entry may name the production host");

    // 4. Contrast case, last so the counts above mean what they say: the real Owner, from the app,
    //    is not locked out by any of this.
    const allowed = await putPolicy(
      { allowInternetAccess: true },
      { ...ownerHeaders, origin: "http://tauri.localhost" },
    );
    assert.equal(allowed.status, 200);
    const policy = await allowed.json();
    assert.equal(policy.status, "AUTO");
    assert.equal(policy.changedBy, "1");
    assert.deepEqual(cloudRequests, ["GET /api/health"], "the legitimate unlock still confirms server time");
  } finally {
    await stopGateway(child);
    await new Promise((resolve) => cloudServer.close(resolve));
  }
});
