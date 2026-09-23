/**
 * One command for a rehearsal against a stand-in cloud: `npm run app:rehearsal`.
 *
 * ## Why this exists
 *
 * The two-window rehearsal in `docs/production/RELEASE_AND_UPDATE_PROCESS.md` is correct, and on
 * 22-23 Sep 2026 it failed the maintainer five different ways in two days, none of them a bug in
 * the thing being rehearsed:
 *
 *  1. A profile name that did not exist yet, so the app opened on the activation screen.
 *  2. The folder name pasted instead of the profile name -- `profile-rehearsal2` becomes
 *     `profile-profile-rehearsal2`, a new empty profile, and the activation screen again.
 *  3. The two `VITE_` variables missing, so the screen said "Not configured" while the gateway said
 *     the cloud was configured.
 *  4. A Vite dev server left over from an earlier launch still holding 5173, so every fresh launch
 *     with the right variables was ignored and the old one kept serving the screen.
 *  5. A stand-in cloud left over from the day before still holding 5090. The new `server.js` did
 *     its whole database bootstrap, reached `app.listen`, died on EADDRINUSE in a wall of text, and
 *     the old process -- running the previous day's code -- kept answering. FROST replied "I did
 *     not catch that" to a reminder the current code handles, and it read as the feature being
 *     broken.
 *
 * Each of those is a thing a person has to remember, in the right window, in the right order. This
 * script remembers them instead.
 *
 * ## What it does
 *
 *  1. Refuses to start without `PGPASSWORD`, or against a database whose name does not end in
 *     `_staging` -- the stand-in cloud must never be pointed at the real books.
 *  2. Stops this repository's own leftovers on 5090 and 5173, identified by command line, never by
 *     port alone. Anything else holding those ports is named and left alone.
 *  3. Starts `backend/server.js` as the stand-in cloud on 5090, with every variable the doc lists,
 *     and waits for `/api/health` to answer. If the process dies first, its last lines are printed
 *     and nothing else starts.
 *  4. Says which commit that cloud is running, so "is it the new code?" is answered on screen.
 *  5. Starts `run-disposable-app.mjs` with the gateway and screen both pointed at 5090 and a named,
 *     reused profile. `FROOZERP_DISPOSABLE_SEED` is removed from its environment: a profile seeded
 *     from live carries the shop's real device identity and must never be pointed at any cloud.
 *  6. Stops the stand-in cloud when the app exits or on Ctrl+C, so it cannot become tomorrow's
 *     leftover.
 *
 * ## What it never does
 *
 * Contact production or Railway. The database URL and both cloud addresses are built here, on
 * loopback, and override anything already in the shell -- including a `DATABASE_URL` left over from
 * applying cloud migrations, which is exactly the variable that would otherwise send a rehearsal
 * into the live books.
 *
 * Usage (PowerShell):
 *
 *   $env:PGPASSWORD = '<the postgres password>'
 *   npm run app:rehearsal
 *
 * Optional: `$env:FROOZERP_REHEARSAL_PROFILE` (default `rehearsal2`),
 * `$env:FROOZERP_REHEARSAL_DATABASE` (default `froozerp_staging`), and `$env:DEVICE_SESSION_SECRET`
 * to keep using a secret from an earlier rehearsal. Without one, a secret is generated once and kept
 * in the disposable root, so sign-ins survive a restart.
 */

import { spawn, spawnSync, execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REHEARSAL_CLOUD_PORT = 5090;
export const REHEARSAL_VITE_PORT = 5173;
export const REHEARSAL_CLOUD_URL = `http://127.0.0.1:${REHEARSAL_CLOUD_PORT}`;
export const DEFAULT_REHEARSAL_PROFILE = "rehearsal2";
export const DEFAULT_REHEARSAL_DATABASE = "froozerp_staging";
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9_]+_staging$/;

/**
 * Everything wrong with the shell before anything starts, as sentences.
 *
 * Returned rather than thrown one at a time: someone fixing variables one refusal per run spends
 * four runs finding out what one run could have told them.
 */
export const rehearsalPreflight = (env = process.env) => {
  const problems = [];
  if (!String(env.PGPASSWORD || "").length) {
    problems.push("PGPASSWORD is not set. Run:  $env:PGPASSWORD = '<the postgres password>'  (single quotes).");
  }
  const database = String(env.FROOZERP_REHEARSAL_DATABASE || DEFAULT_REHEARSAL_DATABASE).trim();
  if (!DATABASE_NAME_PATTERN.test(database)) {
    problems.push(`The rehearsal database must be a copy whose name ends in _staging; "${database}" does not. A rehearsal must never write to the real books.`);
  }
  const profile = String(env.FROOZERP_REHEARSAL_PROFILE || DEFAULT_REHEARSAL_PROFILE).trim();
  if (!PROFILE_NAME_PATTERN.test(profile)) {
    problems.push(`"${profile}" is not a usable profile name: letters, digits, dot, dash or underscore only.`);
  } else if (/^profile-/i.test(profile)) {
    // The folder is `profile-<name>`; the variable takes `<name>`. Pasting the folder name back in
    // made a brand-new empty profile and put the app on the activation screen on 22 Sep 2026.
    problems.push(`Use the profile name without "profile-": "${profile.replace(/^profile-/i, "")}", not "${profile}". The folder adds that prefix itself.`);
  }
  return { ok: problems.length === 0, problems, database, profile };
};

/**
 * The stand-in cloud's environment, with every production-shaped variable overridden.
 *
 * Built from the shell and then *overwritten*, key by key, so nothing already set can win: a
 * `DATABASE_URL` pointing at Railway from an earlier migration run is replaced, not merely
 * shadowed. Every variable in the doc's window 1 is here, because each one fails startup on its own.
 */
export const cloudEnvironment = ({ env = process.env, database, sessionSecret }) => ({
  ...env,
  NODE_ENV: "test",
  FROOZERP_RUNTIME_MODE: "cloud-server",
  FROOZERP_ALLOW_LOOPBACK_POSTGRES_FOR_ISOLATED_TESTS: "true",
  FROOZERP_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS: "true",
  DEVICE_SESSION_SECRET: sessionSecret,
  // The password stays in PGPASSWORD, never in the URL: a password with @ : / # % mis-parses there
  // and reports as "password authentication failed", which reads like a wrong password.
  DATABASE_URL: `postgresql://postgres@127.0.0.1:5432/${database}`,
  PORT: String(REHEARSAL_CLOUD_PORT),
  // A hosted-looking app mode would switch the startup bootstrap off and refuse the loopback
  // database. The stand-in cloud is local by definition.
  APP_MODE: "",
});

/**
 * The disposable app's environment: gateway and screen both told where the cloud is.
 *
 * `FROOZERP_DISPOSABLE_SEED` is deleted, not blanked. The release doc forbids seeding from live
 * while pointing at any cloud -- a seeded profile carries the shop's real device identity -- and a
 * variable left over from an earlier seeded run is exactly how that would happen by accident.
 */
export const appEnvironment = ({ env = process.env, profile }) => {
  const next = {
    ...env,
    FROOZERP_CLOUD_API_URL: REHEARSAL_CLOUD_URL,
    VITE_CLOUD_API_URL: REHEARSAL_CLOUD_URL,
    VITE_ALLOW_LOOPBACK_CLOUD_FOR_ISOLATED_TESTS: "true",
    FROOZERP_DISPOSABLE_PROFILE: profile,
  };
  delete next.FROOZERP_DISPOSABLE_SEED;
  return next;
};

/**
 * Whether a process holding one of our ports is this repository's own leftover.
 *
 * By command line, never by port alone. The ports are ours by convention, not by right, and a
 * script that kills whatever happens to be listening is policing the machine. Matching is on a
 * lowercased, slash-normalised path so `F:\FroozERP\backend\server.js` and `F:/FroozERP/...` agree.
 */
export const isOwnLeftover = ({ commandLine, repoRoot, port }) => {
  const normalise = (value) => String(value || "").replace(/\\/g, "/").toLowerCase();
  const line = normalise(commandLine);
  const root = normalise(repoRoot).replace(/\/+$/, "");
  if (!line || !root) return false;
  if (port === REHEARSAL_CLOUD_PORT) return line.includes(`${root}/backend/server.js`) || /(^|[\s"'])backend\/server\.js/.test(line);
  if (port === REHEARSAL_VITE_PORT) return line.includes(`${root}/frontend`) && line.includes("vite");
  return false;
};

/** The PowerShell that lists who listens on a port, with the command line that started them. */
export const listenerQuery = (port) =>
  `Get-NetTCPConnection -LocalPort ${Number(port)} -State Listen -ErrorAction SilentlyContinue `
  + "| ForEach-Object { $p = Get-CimInstance Win32_Process -Filter \"ProcessId=$($_.OwningProcess)\"; "
  + "\"$($_.OwningProcess)`t$($p.CommandLine)\" }";

const stopOwnLeftovers = ({ repoRoot, port, out }) => {
  if (process.platform !== "win32") return;
  const listed = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", listenerQuery(port)], { encoding: "utf8" });
  if (listed.error || listed.status !== 0) {
    out.write(`  Note: could not check what is using port ${port}. If startup fails with EADDRINUSE, close the old window.\n`);
    return;
  }
  const rows = String(listed.stdout || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const seen = new Set();
  for (const row of rows) {
    const [pid, ...rest] = row.split("\t");
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    const commandLine = rest.join("\t");
    if (!isOwnLeftover({ commandLine, repoRoot, port })) {
      out.write(`  Port ${port} is held by something that is not this rehearsal (PID ${pid}). Leaving it alone.\n`);
      out.write(`    ${commandLine || "(command line not readable)"}\n`);
      out.write(`  Close it yourself if it is an old FroozERP window, then run this again.\n`);
      continue;
    }
    const stopped = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", `Stop-Process -Id ${Number(pid)} -Force`], { encoding: "utf8" });
    out.write(stopped.status === 0
      ? `  Stopped a leftover on port ${port} (PID ${pid}) from an earlier run.\n`
      : `  Could not stop the leftover on port ${port} (PID ${pid}). Close that window and run this again.\n`);
  }
};

/**
 * Whether anything at all is accepting connections on a loopback port.
 *
 * Asked after the leftovers are stopped and before anything starts, because the health check alone
 * cannot tell an old cloud from a new one: a new `server.js` that dies on EADDRINUSE leaves the old
 * process answering `/api/health`, and the rehearsal would carry on against yesterday's code -- the
 * exact failure this script exists to end.
 */
export const portIsHeld = (port, { host = "127.0.0.1", timeoutMs = 1500 } = {}) =>
  new Promise((resolve) => {
    const socket = net.connect({ port: Number(port), host });
    const finish = (held) => {
      socket.destroy();
      resolve(held);
    };
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });

/** Waits for a port to be let go -- a stopped process can hold its socket for a moment. */
const portFreed = async (port, { attempts = 10, intervalMs = 500 } = {}) => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!(await portIsHeld(port))) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
};

/** A session secret that stays the same across restarts, so sign-ins do too. */
export const rehearsalSessionSecret = ({ env = process.env, root, fileSystem = fs } = {}) => {
  const given = String(env.DEVICE_SESSION_SECRET || "");
  if (given.length >= 32) return { secret: given, source: "your DEVICE_SESSION_SECRET" };
  const file = path.join(root, "rehearsal-session-secret");
  try {
    const stored = fileSystem.readFileSync(file, "utf8").trim();
    if (stored.length >= 32) return { secret: stored, source: file };
  } catch {
    // Not written yet. Made below.
  }
  const secret = crypto.randomBytes(32).toString("hex");
  fileSystem.mkdirSync(root, { recursive: true });
  fileSystem.writeFileSync(file, secret, { encoding: "utf8" });
  return { secret, source: `${file} (new: sign in once)` };
};

const currentCommit = (repoRoot) => {
  try {
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    const branch = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
    return `${hash} on ${branch}`;
  } catch {
    return "unknown (git not available here)";
  }
};

const waitForHealth = async ({ child, timeoutMs = 120000, intervalMs = 1000 }) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) return { ok: false, reason: "exited" };
    try {
      const response = await fetch(`${REHEARSAL_CLOUD_URL}/api/health`, { signal: AbortSignal.timeout(3000) });
      if (response.ok) return { ok: true };
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return { ok: false, reason: "timeout" };
};

const main = async () => {
  const out = process.stdout;
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const preflight = rehearsalPreflight(process.env);
  if (!preflight.ok) {
    out.write("\n  Rehearsal not started:\n");
    for (const problem of preflight.problems) out.write(`  - ${problem}\n`);
    out.write("\n");
    process.exit(2);
  }
  const disposableRoot = String(process.env.FROOZERP_DISPOSABLE_ROOT || "").trim() || path.join(os.tmpdir(), "froozerp-disposable");
  const session = rehearsalSessionSecret({ env: process.env, root: disposableRoot });

  out.write("\n  REHEARSAL\n  =========\n");
  out.write(`  Code           : ${currentCommit(repoRoot)}\n`);
  out.write(`  Stand-in cloud : ${REHEARSAL_CLOUD_URL}  ->  database ${preflight.database} on 127.0.0.1\n`);
  out.write(`  App profile    : ${preflight.profile}\n`);
  out.write(`  Session secret : ${session.source}\n\n`);

  stopOwnLeftovers({ repoRoot, port: REHEARSAL_CLOUD_PORT, out });
  stopOwnLeftovers({ repoRoot, port: REHEARSAL_VITE_PORT, out });
  const stillHeld = [];
  for (const port of [REHEARSAL_CLOUD_PORT, REHEARSAL_VITE_PORT]) {
    if (!(await portFreed(port))) stillHeld.push(port);
  }
  if (stillHeld.length) {
    out.write(`\n  Rehearsal not started: port ${stillHeld.join(" and ")} is still in use by an earlier run.\n`);
    out.write("  Close every other PowerShell window that ran the app or node backend/server.js, then run this again.\n");
    out.write("  Starting anyway would leave the OLD code answering and make the new code look broken.\n\n");
    process.exit(5);
  }

  const tail = [];
  const cloud = spawn(process.execPath, [path.join(repoRoot, "backend", "server.js")], {
    cwd: repoRoot,
    env: cloudEnvironment({ env: process.env, database: preflight.database, sessionSecret: session.secret }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  const relay = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line.trim()) continue;
      tail.push(line);
      if (tail.length > 25) tail.shift();
      out.write(`  [cloud] ${line}\n`);
    }
  };
  cloud.stdout.on("data", relay);
  cloud.stderr.on("data", relay);

  const stopCloud = () => {
    if (cloud.exitCode === null) cloud.kill();
  };
  process.once("SIGINT", () => { stopCloud(); process.exit(0); });
  process.once("SIGTERM", () => { stopCloud(); process.exit(0); });

  out.write("  Starting the stand-in cloud...\n");
  const health = await waitForHealth({ child: cloud });
  if (!health.ok) {
    stopCloud();
    out.write(`\n  The stand-in cloud did not come up (${health.reason === "exited" ? "it stopped" : "no answer after two minutes"}).\n`);
    out.write("  Its last lines are above. The usual causes: a wrong PGPASSWORD, Postgres not running,\n");
    out.write(`  or the ${preflight.database} database missing. Nothing else was started.\n\n`);
    process.exit(3);
  }
  out.write(`\n  Stand-in cloud is answering on ${REHEARSAL_CLOUD_URL}. Starting the app...\n\n`);

  const app = spawn(process.execPath, [path.join(repoRoot, "scripts", "run-disposable-app.mjs")], {
    cwd: repoRoot,
    env: appEnvironment({ env: process.env, profile: preflight.profile }),
    stdio: "inherit",
  });
  app.on("exit", (code) => {
    stopCloud();
    process.exit(code ?? 0);
  });
  app.on("error", (error) => {
    stopCloud();
    out.write(`  Could not start the app: ${error.message}\n`);
    process.exit(4);
  });
};

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`run-rehearsal: ${error.message}\n`);
    process.exit(2);
  });
}
