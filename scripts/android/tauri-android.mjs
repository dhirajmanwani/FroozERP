#!/usr/bin/env node
// Cross-platform (Windows + Linux) entry point behind `npm run app:android` and
// `npm run build:android`.
//
//   node scripts/android/tauri-android.mjs dev   [tauri android dev args...]
//   node scripts/android/tauri-android.mjs build [tauri android build args...]
//
// It (1) runs `tauri android init --ci` if src-tauri/gen/android does not exist yet, (2) applies
// scripts/android/patch-android-project.mjs so the generated project never ships with Android
// backup / device transfer enabled, then (3) runs the Tauri CLI from the repo root, the same way the
// desktop `app` / `build:windows` scripts do.
//
// It never signs anything, never reads TAURI_SIGNING_* and never produces updater artifacts:
// the Android overlay (src-tauri/tauri.android.conf.json) has no updater artifacts, and a debug
// APK is signed with the local Android debug keystore only.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { androidProjectDir, manifestPath, patchProject, repoRoot } from "./patch-android-project.mjs";

const cliEntry = path.join(repoRoot, "frontend", "node_modules", "@tauri-apps", "cli", "tauri.js");

function fail(message) {
  console.error(`tauri-android: ${message}`);
  process.exit(1);
}

function tauri(args) {
  console.log(`> tauri ${args.join(" ")}`);
  const result = spawnSync(process.execPath, [cliEntry, ...args], { cwd: repoRoot, stdio: "inherit" });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const [command, ...rest] = process.argv.slice(2);
if (!["dev", "build"].includes(command)) {
  fail("usage: node scripts/android/tauri-android.mjs <dev|build> [tauri args...]");
}
if (!fs.existsSync(cliEntry)) {
  fail("Tauri CLI not found in frontend/node_modules. Run `npm --prefix frontend ci` first.");
}
for (const name of ["ANDROID_HOME", "NDK_HOME"]) {
  if (!process.env[name]) {
    console.warn(`tauri-android: warning: ${name} is not set; see scripts/android/README.md`);
  }
}

if (!fs.existsSync(manifestPath)) {
  if (fs.existsSync(androidProjectDir)) {
    fail(
      `${path.relative(repoRoot, androidProjectDir)} exists but has no app/src/main/AndroidManifest.xml. `
      + "Delete that folder and run this again to regenerate it.",
    );
  }
  tauri(["android", "init", "--ci"]);
}

try {
  // `tauri android dev` needs cleartext in the debug build type for the Vite HMR websocket;
  // an APK that goes onto a phone does not.
  patchProject({ allowDevCleartext: command === "dev" });
} catch (error) {
  fail(`patching the generated Android project FAILED: ${error.message}`);
}

tauri(["android", command, ...rest]);
