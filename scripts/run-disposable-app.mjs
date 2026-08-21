#!/usr/bin/env node
/**
 * Launch the desktop app against a **fresh disposable SQLite profile**, never live app data.
 *
 * ## Why this exists
 *
 * `resolve_app_data_dir` (`src-tauri/src/local_db.rs`) redirects the database away from the real
 * profile only when **both** `NODE_ENV=test` and an absolute `FROOZERP_ISOLATED_SQLITE_DIR` are
 * set. `npm run app` sets neither, so a plain dev run opens the maintainer's real business data.
 * `docs/offline-activation-plan.md` flags this in writing, and it still went wrong in practice on
 * 2026-08-18: environment variables are per-shell-window, several windows were open during a long
 * debugging session, and one `npm run app` came from a window where they had never been set. That
 * instance applied pending migrations and wrote a grandfather entitlement into the live profile.
 * No business data was lost, but nobody chose for it to happen.
 *
 * A rule that must be re-typed correctly in every new terminal is not a safeguard. This script
 * makes the safe path the short one: `npm run app:disposable` cannot forget the variables, because
 * it sets them itself, and it refuses to start if they would point anywhere near live app data.
 *
 * ## What it does
 *
 * 1. Resolves a disposable root (`FROOZERP_DISPOSABLE_ROOT`, else the OS temp directory).
 * 2. Creates a fresh timestamped directory under it — never reusing an old one, so each run starts
 *    from a genuinely empty profile rather than inheriting a half-activated one.
 * 3. Refuses to continue if that path is not absolute, or looks like the real app-data directory.
 * 4. Prints the path it will use, so "which database did that write to?" is answerable by reading
 *    the terminal instead of by forensics afterwards.
 * 5. Runs the same Tauri dev command as `npm run app`, with the isolation variables set.
 *
 * Usage:
 *   npm run app:disposable
 * The examples below are PowerShell, because Windows is the only shipped target and PowerShell is
 * the shell in CLAUDE.md. They were written in `VAR=value command` form, which is bash: PowerShell
 * reads that as a command name and answers "is not recognized as the name of a cmdlet". Usage
 * examples that fail on the only supported platform are worse than none, because they cost someone
 * a confusing error before they can start.
 *
 *   $env:FROOZERP_DISPOSABLE_ROOT = "F:\froozerp-disposable"
 *   npm run app:disposable
 *
 *   # A named profile survives between runs, so the device stays activated:
 *   $env:FROOZERP_DISPOSABLE_PROFILE = "test"
 *   npm run app:disposable
 *
 *   # ...and seeding it from a copy of the live database means it never needs activating at all.
 *   # Close the real app first: copying a live SQLite file mid-write can capture a torn state.
 *   $env:FROOZERP_DISPOSABLE_PROFILE = "test"
 *   $env:FROOZERP_DISPOSABLE_SEED = "live"
 *   npm run app:disposable
 *
 *   # `$env:` values live as long as the window does. That is the same per-window statefulness that
 *   # caused the 2026-08-18 incident above, so clear them or close the terminal when finished:
 *   Remove-Item Env:FROOZERP_DISPOSABLE_PROFILE, Env:FROOZERP_DISPOSABLE_SEED
 *
 * On bash or zsh the inline form still works:
 *   FROOZERP_DISPOSABLE_PROFILE=test FROOZERP_DISPOSABLE_SEED=live npm run app:disposable
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The bundle identifier from `src-tauri/tauri.conf.json`; the live profile lives under it. */
export const APP_IDENTIFIER = "com.srtcompany.froozerp";

/**
 * Would this path put us in (or under) the real profile directory?
 *
 * Deliberately blunt: any path containing the bundle identifier is refused, whatever the platform
 * or however it was reached. A disposable profile has no reason to sit inside the live app-data
 * folder, so a false refusal costs one rename while a false accept costs live data.
 */
export const isLiveAppDataPath = (candidate) =>
  String(candidate || "").toLowerCase().includes(APP_IDENTIFIER);

/** Timestamp component of the directory name. Sorts chronologically; no separators needing quoting. */
export const disposableStamp = (now = new Date()) => {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join("");
};

/** Characters allowed in a named profile. Keeps the name a single, quoting-free path segment. */
const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * Resolve the directory this run will use.
 *
 * ## Fresh by default, named on request
 *
 * The default is a new timestamped directory every run, because the thing this script exists to
 * prevent is a run that quietly inherits state from somewhere it should not.
 *
 * But **entitlements are bound to a device id** (`device_binding` in `src-tauri/src/entitlement.rs`
 * is a hash of it), and a brand-new profile means a brand-new device. So a fresh profile always
 * opens on the activation screen, and testing anything past it would mean signing a new `.lic`
 * against a new device id on every single run — which is not a test loop anybody sustains.
 *
 * A **named** profile is the answer: still isolated by exactly the same guards, still never live
 * app data, but stable across runs so a device stays activated once. That is what makes it possible
 * to test the app rather than the activation screen.
 *
 * Names are restricted to one plain path segment. A name containing `..` or a separator could climb
 * out of the disposable root, and the whole value of this script is that it cannot.
 *
 * @throws when the result is relative (the Rust side rejects it) or points at live app data.
 */
export const resolveDisposableDir = ({ root, profile = "", now = new Date() } = {}) => {
  const base = root && String(root).trim().length > 0
    ? String(root).trim()
    : path.join(os.tmpdir(), "froozerp-disposable");

  if (isLiveAppDataPath(base)) {
    throw new Error(
      `refusing to use ${base}: it is inside the live application data directory (${APP_IDENTIFIER}).`,
    );
  }

  const name = String(profile || "").trim();
  if (name && !PROFILE_NAME_PATTERN.test(name)) {
    throw new Error(
      `refusing to use profile name ${JSON.stringify(name)}: use letters, digits, dot, dash or ` +
      "underscore only — a name with a separator or '..' could escape the disposable root.",
    );
  }

  const resolved = path.resolve(base, name ? `profile-${name}` : `run-${disposableStamp(now)}`);
  // Containment, asserted rather than reasoned about. The `profile-` prefix happens to make a name
  // like `..` a literal directory instead of a climb, but that is a property of the prefix, and a
  // later edit to the naming could remove it without anyone noticing. Comparing the resolved path
  // against the resolved base is the property that actually matters, checked directly.
  const resolvedBase = path.resolve(base);
  if (resolved !== resolvedBase && !resolved.startsWith(resolvedBase + path.sep)) {
    throw new Error(`refusing to use ${resolved}: it resolves outside the disposable root ${resolvedBase}.`);
  }
  if (!path.isAbsolute(resolved)) {
    // Belt and braces: path.resolve always returns absolute, but the Rust guard depends on it and
    // a silent relative path would fall back to live data rather than failing.
    throw new Error(`refusing to use ${resolved}: FROOZERP_ISOLATED_SQLITE_DIR must be absolute.`);
  }
  if (isLiveAppDataPath(resolved)) {
    throw new Error(`refusing to use ${resolved}: it resolves into live application data.`);
  }
  return resolved;
};

/** The database file inside a profile directory. Everything that matters lives in it. */
export const PROFILE_DATABASE = "froozerp-local.sqlite3";

/**
 * SQLite's sidecar files. A copy that takes only the `.sqlite3` and leaves a populated `-wal`
 * behind is not a copy of the database — it is a copy of the database as it stood before the most
 * recent transactions, which is a subtly wrong starting state rather than an obviously broken one.
 */
const PROFILE_DATABASE_PARTS = [PROFILE_DATABASE, `${PROFILE_DATABASE}-wal`, `${PROFILE_DATABASE}-shm`];

/**
 * Where the real profile lives, per `src-tauri/src/lib.rs` and `backend/desktopGateway.js`.
 *
 * Read only, ever. Nothing in this script writes to it, and the copy direction is enforced by
 * `seedDisposableProfile` refusing any destination that `isLiveAppDataPath` recognises.
 */
export const liveProfileDir = (env = process.env, platform = process.platform) => {
  if (platform === "win32" && env.APPDATA) return path.join(env.APPDATA, APP_IDENTIFIER);
  return path.join(os.homedir(), "AppData", "Roaming", APP_IDENTIFIER);
};

/**
 * Copy the live database into a disposable profile, once.
 *
 * ## Why this exists
 *
 * Entitlements are bound to a device id, so a profile created from nothing is a new device and
 * lands on the activation screen. Getting past it means signing a `.lic` against the new device id
 * — which is fine once and intolerable as a routine, and a safe path that is tedious is a safe path
 * people stop taking.
 *
 * Seeding from a copy of the live database sidesteps it entirely: the copy carries the device id
 * and the entitlement that was already issued for it, so the disposable profile opens *already
 * activated*, with real data, and never needs signing at all. `CLAUDE.md` prescribes exactly this
 * — "use disposable copies of databases, profiles and app state" — and this makes the copy a
 * command rather than a manual step performed correctly under time pressure.
 *
 * ## Safety
 *
 * One direction only. The source is opened for reading; the destination is refused outright if it
 * looks like live app data. It seeds only when the destination database does **not** exist, so a
 * second run never overwrites work done in the disposable profile — and never silently re-copies
 * live data over a state the maintainer was mid-way through testing.
 *
 * @returns {{seeded: boolean, reason: string, from?: string, files?: string[]}}
 */
export const seedDisposableProfile = ({ sourceDir, destinationDir, fileSystem = fs } = {}) => {
  if (isLiveAppDataPath(destinationDir)) {
    throw new Error(`refusing to seed into ${destinationDir}: it is live application data.`);
  }
  const sourceDatabase = path.join(sourceDir, PROFILE_DATABASE);
  if (!fileSystem.existsSync(sourceDatabase)) {
    return { seeded: false, reason: `no live database found at ${sourceDatabase}` };
  }
  if (fileSystem.existsSync(path.join(destinationDir, PROFILE_DATABASE))) {
    return { seeded: false, reason: "this profile already has a database; leaving it alone" };
  }

  const copied = [];
  for (const name of PROFILE_DATABASE_PARTS) {
    const from = path.join(sourceDir, name);
    if (!fileSystem.existsSync(from)) continue;
    fileSystem.copyFileSync(from, path.join(destinationDir, name));
    copied.push(name);
  }
  return { seeded: true, reason: "copied from the live profile", from: sourceDir, files: copied };
};

/**
 * Path to the Tauri CLI's JavaScript entry point.
 *
 * Deliberately NOT `node_modules/.bin/tauri(.cmd)`. On Windows that shim is a `.cmd` batch file,
 * and Node refuses to `spawn()` a `.cmd` directly — it fails with `EINVAL`. (The restriction came
 * in with the fix for CVE-2024-27980, where argument escaping for batch files was exploitable.)
 * The usual workaround, `shell: true`, re-opens exactly that hole and additionally breaks on any
 * path containing a space, which `C:\Users\...` frequently does.
 *
 * Running the CLI's own `.js` through `process.execPath` sidesteps both problems and behaves
 * identically on Windows, macOS and Linux — there is no shell in the picture to disagree about.
 */
export const tauriCliEntry = (repoRoot) =>
  path.join(repoRoot, "frontend", "node_modules", "@tauri-apps", "cli", "tauri.js");

const main = () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const profile = process.env.FROOZERP_DISPOSABLE_PROFILE || "";
  const dir = resolveDisposableDir({ root: process.env.FROOZERP_DISPOSABLE_ROOT, profile });
  const reused = profile && fs.existsSync(path.join(dir, PROFILE_DATABASE));
  fs.mkdirSync(dir, { recursive: true });

  // Opt-in, never automatic: copying real business data anywhere should be something the maintainer
  // asked for by name, not something a script decided was convenient.
  let seed = { seeded: false, reason: "not requested" };
  if (String(process.env.FROOZERP_DISPOSABLE_SEED || "").trim().toLowerCase() === "live") {
    seed = seedDisposableProfile({ sourceDir: liveProfileDir(), destinationDir: dir });
  }

  process.stdout.write(
    [
      "",
      "  DISPOSABLE PROFILE RUN",
      "  ======================",
      `  SQLite profile : ${dir}`,
      `  Profile mode   : ${profile ? `named "${profile}" — ${reused ? "REUSED, already activated" : "new"}` : "fresh every run — will open on the activation screen"}`,
      `  Seeded         : ${seed.seeded ? `yes, ${seed.files.join(", ")} — opens already activated` : seed.reason}`,
      "  Live app data  : untouched (read only, never written)",
      "",
      "  This run cannot reach the real profile: NODE_ENV=test and an absolute",
      "  FROOZERP_ISOLATED_SQLITE_DIR are both set for the child process only.",
      "  Verify by file timestamp in the directory above if anything looks wrong.",
      "",
      "",
    ].join("\n"),
  );

  const cliEntry = tauriCliEntry(repoRoot);
  if (!fs.existsSync(cliEntry)) {
    throw new Error(
      `Tauri CLI not found at ${cliEntry}. Run \`npm --prefix frontend install\` first.`,
    );
  }

  const child = spawn(process.execPath, [cliEntry, "dev"], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      NODE_ENV: "test",
      FROOZERP_ISOLATED_SQLITE_DIR: dir,
    },
  });

  child.on("exit", (code, signal) => {
    process.exit(signal ? 1 : code ?? 0);
  });
  child.on("error", (error) => {
    process.stderr.write(`run-disposable-app: cannot start tauri: ${error.message}\n`);
    process.exit(2);
  });
};

const invokedDirectly = process.argv[1]
  && fileURLToPath(import.meta.url) === process.argv[1];

if (invokedDirectly) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`run-disposable-app: ${error.message}\n`);
    process.exit(2);
  }
}
