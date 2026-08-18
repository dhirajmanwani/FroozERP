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
 *   FROOZERP_DISPOSABLE_ROOT=F:\froozerp-disposable npm run app:disposable
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

/**
 * Resolve the directory this run will use.
 *
 * @throws when the result is relative (the Rust side rejects it) or points at live app data.
 */
export const resolveDisposableDir = ({ root, now = new Date() } = {}) => {
  const base = root && String(root).trim().length > 0
    ? String(root).trim()
    : path.join(os.tmpdir(), "froozerp-disposable");

  if (isLiveAppDataPath(base)) {
    throw new Error(
      `refusing to use ${base}: it is inside the live application data directory (${APP_IDENTIFIER}).`,
    );
  }

  const resolved = path.resolve(base, `run-${disposableStamp(now)}`);
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

const tauriBinary = (repoRoot) => {
  const bin = process.platform === "win32" ? "tauri.cmd" : "tauri";
  return path.join(repoRoot, "frontend", "node_modules", ".bin", bin);
};

const main = () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const dir = resolveDisposableDir({ root: process.env.FROOZERP_DISPOSABLE_ROOT });
  fs.mkdirSync(dir, { recursive: true });

  process.stdout.write(
    [
      "",
      "  DISPOSABLE PROFILE RUN",
      "  ======================",
      `  SQLite profile : ${dir}`,
      "  Live app data  : untouched",
      "",
      "  This run cannot reach the real profile: NODE_ENV=test and an absolute",
      "  FROOZERP_ISOLATED_SQLITE_DIR are both set for the child process only.",
      "  Verify by file timestamp in the directory above if anything looks wrong.",
      "",
      "",
    ].join("\n"),
  );

  const child = spawn(tauriBinary(repoRoot), ["dev"], {
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
