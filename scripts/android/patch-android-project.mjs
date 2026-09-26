#!/usr/bin/env node
// Hardens the Android project that `tauri android init` generates under src-tauri/gen/android.
//
// The generated project is not committed; it is recreated by `tauri android init` (CI does this on
// every run). This script is run straight after init, and again before every local build, so the
// hardening can never be lost to a regeneration. It is idempotent: a second run changes nothing.
//
// What it enforces, and why:
//
// 1. No Android backup and no device-to-device transfer of app data.
//    The phone's SQLite database and its device identity (device id, session, activation) must
//    never be restored onto another phone: two devices with one identity would both sync as the
//    same counter. Three attributes are needed, because each covers a different Android range:
//      - android:allowBackup="false"          -> turns off Auto Backup / adb backup (all versions)
//      - android:fullBackupContent="false"    -> belt and braces for Android 6-11 (API 23-30)
//      - android:dataExtractionRules=@xml/... -> Android 12+ (API 31+). On 12+, allowBackup="false"
//        does NOT stop device-to-device migration (the "copy your apps to the new phone" flow);
//        only an explicit <device-transfer> exclusion does. The rules file excludes every domain
//        from both cloud backup and device transfer.
//
// 2. No cleartext HTTP from the WebView, except in `tauri android dev`.
//    Tauri does not need cleartext for its own origin: the app is served at http://tauri.localhost
//    through a custom-protocol interceptor inside the WebView, not over the network, which is why
//    Tauri's own template already sets usesCleartextTraffic=false for release builds (and in dev,
//    tauri 2.11 proxies the Vite server through the same interceptor). The template turns cleartext
//    ON for the whole debug build type only so that the Vite dev server's HMR websocket
//    (ws://<laptop-ip>:5173) works in `tauri android dev`.
//    The APK we hand to phones is a *debug* build, so by default this script turns debug cleartext
//    OFF as well: sessions are bearer tokens and one plaintext request is a full account takeover.
//    `--allow-dev-cleartext` puts the template's debug "true" back, for `npm run app:android` only.
//
// Usage:
//   node scripts/android/patch-android-project.mjs                        # APK builds (default)
//   node scripts/android/patch-android-project.mjs --allow-dev-cleartext  # `tauri android dev`
//
// It fails loudly (non-zero exit, no partial write) if the generated project is not where it
// expects, or if the template has changed shape so that a patch cannot be applied with certainty.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(scriptDir, "..", "..");
export const androidProjectDir = path.join(repoRoot, "src-tauri", "gen", "android");
export const manifestPath = path.join(androidProjectDir, "app", "src", "main", "AndroidManifest.xml");
export const appGradlePath = path.join(androidProjectDir, "app", "build.gradle.kts");
export const dataExtractionRulesName = "froozerp_data_extraction_rules";
export const dataExtractionRulesPath = path.join(
  androidProjectDir, "app", "src", "main", "res", "xml", `${dataExtractionRulesName}.xml`,
);

// Every storage domain Android backup knows about, credential-protected and device-protected.
const BACKUP_DOMAINS = [
  "root", "file", "database", "sharedpref", "external",
  "device_root", "device_file", "device_database", "device_sharedpref",
];
const excludeAll = BACKUP_DOMAINS
  .map((domain) => `        <exclude domain="${domain}" path="." />`)
  .join("\n");

export const DATA_EXTRACTION_RULES_XML = `<?xml version="1.0" encoding="utf-8"?>
<!--
  Written by scripts/android/patch-android-project.mjs. Do not edit here; the gen/android project is
  regenerated. Nothing of FroozERP's is backed up to the cloud or copied to a new phone: the local
  SQLite database and the device identity belong to this one device only.
-->
<data-extraction-rules>
    <cloud-backup>
${excludeAll}
    </cloud-backup>
    <device-transfer>
${excludeAll}
    </device-transfer>
</data-extraction-rules>
`;

export const REQUIRED_APPLICATION_ATTRIBUTES = [
  ["android:allowBackup", "false"],
  ["android:fullBackupContent", "false"],
  ["android:dataExtractionRules", `@xml/${dataExtractionRulesName}`],
];

class PatchError extends Error {}

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function patchManifest(source) {
  const tags = source.match(/<application\b[^>]*>/g) || [];
  if (tags.length !== 1) {
    throw new PatchError(`expected exactly one <application> element in AndroidManifest.xml, found ${tags.length}`);
  }
  const original = tags[0];
  if (/\/>$/.test(original)) {
    throw new PatchError("<application> is self-closing; the Tauri template has changed shape");
  }
  if (!/android:usesCleartextTraffic\s*=\s*"\$\{usesCleartextTraffic\}"/.test(original)) {
    throw new PatchError(
      'android:usesCleartextTraffic is not the "${usesCleartextTraffic}" placeholder; cleartext would no '
      + "longer be governed by build.gradle.kts. Refusing to guess.",
    );
  }

  const indent = (original.match(/\n([ \t]+)android:/) || [null, "        "])[1];
  let tag = original;
  for (const [name, value] of REQUIRED_APPLICATION_ATTRIBUTES) {
    const attr = new RegExp(`${escapeRegExp(name)}\\s*=\\s*"[^"]*"`);
    if (attr.test(tag)) {
      tag = tag.replace(attr, `${name}="${value}"`);
    } else {
      tag = tag.replace(/\s*>$/, `\n${indent}${name}="${value}">`);
    }
  }
  return source.replace(original, tag);
}

const CLEARTEXT_LINE = /manifestPlaceholders\["usesCleartextTraffic"\]\s*=\s*"(true|false)"/g;

export function patchGradle(source, { allowDevCleartext = false } = {}) {
  const occurrences = [...source.matchAll(CLEARTEXT_LINE)];
  const debugAt = source.search(/getByName\(\s*"debug"\s*\)\s*\{/);
  const releaseAt = source.search(/getByName\(\s*"release"\s*\)\s*\{/);
  if (debugAt < 0 || releaseAt < 0) {
    throw new PatchError('build.gradle.kts has no getByName("debug") / getByName("release") build types');
  }
  const blockEnd = releaseAt > debugAt ? releaseAt : source.length;
  const defaults = occurrences.filter((m) => m.index < Math.min(debugAt, releaseAt));
  const debug = occurrences.filter((m) => m.index > debugAt && m.index < blockEnd);
  // Exactly two: defaultConfig (applies to release) and the debug override. Anything else, such
  // as a release override, means the template changed and we would be guessing.
  if (defaults.length !== 1 || debug.length !== 1 || occurrences.length !== 2) {
    throw new PatchError(
      "expected usesCleartextTraffic to be set once in defaultConfig and once in the debug build type "
      + `(found defaultConfig=${defaults.length}, debug=${debug.length}, total=${occurrences.length}); `
      + "the Tauri template has changed shape",
    );
  }
  const want = (match, value) => match[0].replace(/"(true|false)"$/, `"${value}"`);
  const edits = [
    [defaults[0], "false"],
    [debug[0], allowDevCleartext ? "true" : "false"],
  ].sort((a, b) => b[0].index - a[0].index);
  let out = source;
  for (const [match, value] of edits) {
    out = out.slice(0, match.index) + want(match, value) + out.slice(match.index + match[0].length);
  }
  return out;
}

// 3. Gradle calls back into the Tauri CLI to build the Rust library. `tauri android init` writes how
//    to do that into buildSrc/.../BuildTask.kt, and when it cannot tell how it was started it writes
//    `node tauri android android-studio-script`, run from src-tauri, which finds no `tauri` there.
//    The CLI lives in frontend/node_modules, so the call is pointed at its tauri.js explicitly.
export const TAURI_CLI_FROM_SRC_TAURI = "../frontend/node_modules/@tauri-apps/cli/tauri.js";
const BUILD_TASK_ARGS = /val args = listOf\(([^)]*)\);/;

export function patchBuildTask(source) {
  const executable = source.match(/val executable = """([^"]*)""";/);
  if (!executable) throw new PatchError("BuildTask.kt has no `val executable = \"\"\"...\"\"\";` line; the template changed shape.");
  const args = source.match(BUILD_TASK_ARGS);
  if (!args) throw new PatchError("BuildTask.kt has no `val args = listOf(...);` line; the template changed shape.");
  const wanted = `"${TAURI_CLI_FROM_SRC_TAURI}", "android", "android-studio-script"`;
  if (executable[1] === "node" && args[1] === wanted) return source;
  if (!/"android", "android-studio-script"$/.test(args[1])) {
    throw new PatchError(`BuildTask.kt calls the CLI with unexpected arguments (${args[1]}); refusing to guess.`);
  }
  return source
    .replace(executable[0], 'val executable = """node""";')
    .replace(BUILD_TASK_ARGS, `val args = listOf(${wanted});`);
}

export function findBuildTask(projectDir = androidProjectDir) {
  const root = path.join(projectDir, "buildSrc");
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.name === "BuildTask.kt") return full;
    }
  }
  throw new PatchError(`BuildTask.kt not found under ${path.relative(repoRoot, root)}. Run \`tauri android init --ci\` first.`);
}

function readRequired(file, what) {
  if (!fs.existsSync(file)) {
    throw new PatchError(
      `${what} not found at ${path.relative(repoRoot, file)}. Run \`tauri android init --ci\` first `
      + "(npm run build:android does it for you).",
    );
  }
  return fs.readFileSync(file, "utf8");
}

export function patchProject({ allowDevCleartext = false, log = console.log } = {}) {
  const manifest = readRequired(manifestPath, "Generated AndroidManifest.xml");
  const gradle = readRequired(appGradlePath, "Generated app/build.gradle.kts");

  // Compute everything before writing anything, so a shape error leaves the project untouched.
  const nextManifest = patchManifest(manifest);
  const nextGradle = patchGradle(gradle, { allowDevCleartext });
  const buildTaskPath = findBuildTask();
  const buildTask = fs.readFileSync(buildTaskPath, "utf8");
  const nextBuildTask = patchBuildTask(buildTask);
  const rulesCurrent = fs.existsSync(dataExtractionRulesPath)
    ? fs.readFileSync(dataExtractionRulesPath, "utf8")
    : null;

  const changed = [];
  if (rulesCurrent !== DATA_EXTRACTION_RULES_XML) {
    fs.mkdirSync(path.dirname(dataExtractionRulesPath), { recursive: true });
    fs.writeFileSync(dataExtractionRulesPath, DATA_EXTRACTION_RULES_XML);
    changed.push(dataExtractionRulesPath);
  }
  if (nextManifest !== manifest) {
    fs.writeFileSync(manifestPath, nextManifest);
    changed.push(manifestPath);
  }
  if (nextGradle !== gradle) {
    fs.writeFileSync(appGradlePath, nextGradle);
    changed.push(appGradlePath);
  }
  if (nextBuildTask !== buildTask) {
    fs.writeFileSync(buildTaskPath, nextBuildTask);
    changed.push(buildTaskPath);
  }

  // Post-conditions, re-read from disk.
  const finalManifest = fs.readFileSync(manifestPath, "utf8");
  for (const [name, value] of REQUIRED_APPLICATION_ATTRIBUTES) {
    if (!finalManifest.includes(`${name}="${value}"`)) {
      throw new PatchError(`post-check failed: ${name}="${value}" missing from AndroidManifest.xml`);
    }
  }
  if (patchGradle(fs.readFileSync(appGradlePath, "utf8"), { allowDevCleartext })
    !== fs.readFileSync(appGradlePath, "utf8")) {
    throw new PatchError("post-check failed: build.gradle.kts is not stable under a second patch");
  }

  const rel = (file) => path.relative(repoRoot, file).split(path.sep).join("/");
  if (changed.length) {
    for (const file of changed) log(`patched ${rel(file)}`);
  } else {
    log("Android project already patched; nothing to do.");
  }
  log(`backup + device transfer: disabled; debug cleartext: ${allowDevCleartext ? "ALLOWED (dev only)" : "blocked"}; release cleartext: blocked`);
  return changed;
}

const invokedDirectly = process.argv[1]
  && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;

if (invokedDirectly) {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--allow-dev-cleartext");
  if (unknown.length) {
    console.error(`patch-android-project: unknown argument(s): ${unknown.join(" ")}`);
    process.exit(2);
  }
  try {
    patchProject({ allowDevCleartext: args.includes("--allow-dev-cleartext") });
  } catch (error) {
    console.error(`patch-android-project: FAILED: ${error.message}`);
    process.exit(1);
  }
}
