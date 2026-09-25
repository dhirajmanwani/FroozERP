import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_REHEARSAL_DATABASE,
  DEFAULT_REHEARSAL_PROFILE,
  REHEARSAL_CLOUD_PORT,
  REHEARSAL_CLOUD_URL,
  REHEARSAL_VITE_PORT,
  appEnvironment,
  cloudEnvironment,
  isOwnLeftover,
  portIsHeld,
  rehearsalPreflight,
  rehearsalSessionSecret,
} from "../../../scripts/run-rehearsal.mjs";

test("preflight refuses without a Postgres password, and says how to set one", () => {
  const result = rehearsalPreflight({});
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /PGPASSWORD is not set/);
});

test("preflight defaults to the rehearsal2 profile and the staging copy", () => {
  const result = rehearsalPreflight({ PGPASSWORD: "x" });
  assert.equal(result.ok, true);
  assert.equal(result.profile, DEFAULT_REHEARSAL_PROFILE);
  assert.equal(result.database, DEFAULT_REHEARSAL_DATABASE);
});

test("preflight refuses any database that is not a _staging copy", () => {
  for (const database of ["froozerp", "railway", "froozerp_staging2", "x_staging;drop"]) {
    const result = rehearsalPreflight({ PGPASSWORD: "x", FROOZERP_REHEARSAL_DATABASE: database });
    assert.equal(result.ok, false, database);
    assert.match(result.problems.join("\n"), /_staging/);
  }
});

test("preflight catches the folder name pasted in place of the profile name", () => {
  const result = rehearsalPreflight({ PGPASSWORD: "x", FROOZERP_REHEARSAL_PROFILE: "profile-rehearsal2" });
  assert.equal(result.ok, false);
  assert.match(result.problems.join("\n"), /"rehearsal2", not "profile-rehearsal2"/);
});

test("preflight lists every problem at once", () => {
  const result = rehearsalPreflight({ FROOZERP_REHEARSAL_DATABASE: "live", FROOZERP_REHEARSAL_PROFILE: "a b" });
  assert.equal(result.problems.length, 3);
});

test("the stand-in cloud's database is loopback even when the shell points at Railway", () => {
  const env = cloudEnvironment({
    env: {
      DATABASE_URL: "postgresql://postgres:secret@railway.example:5432/railway",
      NODE_ENV: "production",
      PORT: "5000",
      APP_MODE: "CLOUD",
      FROOZERP_RUNTIME_MODE: "desktop-local",
      PGPASSWORD: "kept",
    },
    database: "froozerp_staging",
    sessionSecret: "s".repeat(40),
  });
  assert.equal(env.DATABASE_URL, "postgresql://postgres@127.0.0.1:5432/froozerp_staging");
  assert.equal(env.NODE_ENV, "test");
  assert.equal(env.PORT, String(REHEARSAL_CLOUD_PORT));
  assert.equal(env.APP_MODE, "");
  assert.equal(env.FROOZERP_RUNTIME_MODE, "cloud-server");
  assert.equal(env.FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS, "true");
  assert.equal(env.FROOZERP_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS, "true");
  assert.equal(env.DEVICE_SESSION_SECRET, "s".repeat(40));
  assert.equal(env.PGPASSWORD, "kept");
});

test("the app is pointed at the stand-in cloud on both the gateway and the screen, and never seeded", () => {
  const env = appEnvironment({
    env: { FROOZERP_DISPOSABLE_SEED: "live", FROOZERP_CLOUD_API_URL: "https://froozerp-production-27bb.up.railway.app" },
    profile: "rehearsal2",
  });
  assert.equal(REHEARSAL_CLOUD_URL, "http://127.0.0.1:5090");
  assert.equal(env.FROOZERP_CLOUD_API_URL, REHEARSAL_CLOUD_URL);
  assert.equal(env.VITE_CLOUD_API_URL, REHEARSAL_CLOUD_URL);
  assert.equal(env.VITE_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS, "true");
  assert.equal(env.FROOZERP_DISPOSABLE_PROFILE, "rehearsal2");
  assert.equal("FROOZERP_DISPOSABLE_SEED" in env, false);
});

test("only this repository's own server and Vite count as leftovers", () => {
  const repoRoot = "F:\\FroozERP";
  assert.equal(isOwnLeftover({ commandLine: "\"C:\\Program Files\\nodejs\\node.exe\" F:\\FroozERP\\backend\\server.js", repoRoot, port: REHEARSAL_CLOUD_PORT }), true);
  assert.equal(isOwnLeftover({ commandLine: "node  backend/server.js", repoRoot, port: REHEARSAL_CLOUD_PORT }), true);
  assert.equal(isOwnLeftover({ commandLine: "node f:/froozerp/frontend/node_modules/vite/bin/vite.js --host 0.0.0.0", repoRoot, port: REHEARSAL_VITE_PORT }), true);
  // Someone else's program on our ports is theirs.
  assert.equal(isOwnLeftover({ commandLine: "C:\\Program Files\\FroozERP\\froozerp-backend-node.exe gateway.js", repoRoot, port: REHEARSAL_CLOUD_PORT }), false);
  assert.equal(isOwnLeftover({ commandLine: "node D:\\other\\frontend\\node_modules\\vite\\bin\\vite.js", repoRoot, port: REHEARSAL_VITE_PORT }), false);
  assert.equal(isOwnLeftover({ commandLine: "python -m http.server 5090", repoRoot, port: REHEARSAL_CLOUD_PORT }), false);
  // The Vite rule does not stretch to the cloud port, or the other way round.
  assert.equal(isOwnLeftover({ commandLine: "node F:\\FroozERP\\backend\\server.js", repoRoot, port: REHEARSAL_VITE_PORT }), false);
  assert.equal(isOwnLeftover({ commandLine: "", repoRoot, port: REHEARSAL_CLOUD_PORT }), false);
});

test("the session secret is kept across restarts, so a sign-in survives one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "rehearsal-secret-"));
  try {
    const first = rehearsalSessionSecret({ env: {}, root });
    assert.ok(first.secret.length >= 32);
    assert.match(first.source, /new: sign in once/);
    const second = rehearsalSessionSecret({ env: {}, root });
    assert.equal(second.secret, first.secret);
    assert.doesNotMatch(second.source, /new/);
    const given = rehearsalSessionSecret({ env: { DEVICE_SESSION_SECRET: "g".repeat(32) }, root });
    assert.equal(given.secret, "g".repeat(32));
    // Too short to be accepted by sessionSecret.js, so it is not used.
    assert.equal(rehearsalSessionSecret({ env: { DEVICE_SESSION_SECRET: "short" }, root }).secret, first.secret);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("a port somebody is listening on reads as held, and a free one does not", async () => {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    assert.equal(await portIsHeld(port), true);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  assert.equal(await portIsHeld(port), false);
});

test("the launcher refuses to start over a port an earlier run still holds", () => {
  // The health check alone cannot tell an old cloud from a new one; this is what does.
  const source = fs.readFileSync(new URL("../../../scripts/run-rehearsal.mjs", import.meta.url), "utf8");
  const refusal = source.indexOf("is still in use by an earlier run");
  const spawnCloud = source.indexOf("const cloud = spawn(");
  assert.ok(refusal > 0 && spawnCloud > refusal, "the port check must come before the cloud starts");
  assert.match(source.slice(refusal, spawnCloud), /process\.exit\(5\)/);
});

test("npm run app:rehearsal runs the launcher", () => {
  const pkg = JSON.parse(fs.readFileSync(new URL("../../../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["app:rehearsal"], "node scripts/run-rehearsal.mjs");
});
