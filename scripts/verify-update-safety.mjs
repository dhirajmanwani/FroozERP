import fs from "node:fs";
import path from "node:path";

const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");
const rootPackagePath = path.join(root, "package.json");
const backendPackagePath = path.join(root, "backend", "package.json");
const frontendPackagePath = path.join(root, "frontend", "package.json");
const hookPath = path.join(root, "src-tauri", "installer", "froozerp-cleanup-hooks.nsh");
const unsignedOverlayPath = path.join(root, "src-tauri", "tauri.unsigned.conf.json5");
const releaseWorkflowPath = path.join(root, ".github", "workflows", "windows-updater-release.yml");
const appDataDir = path.join(process.env.APPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Roaming"), "com.srtcompany.froozerp");
const installDir = path.join(process.env.ProgramFiles || "C:\\Program Files", "FroozERP");

const tauriConfig = JSON.parse(fs.readFileSync(tauriConfigPath, "utf8"));
const rootPackage = JSON.parse(fs.readFileSync(rootPackagePath, "utf8"));
const releaseWorkflow = fs.existsSync(releaseWorkflowPath) ? fs.readFileSync(releaseWorkflowPath, "utf8") : "";
const releaseVersions = {
  workspace: rootPackage.version,
  backend: JSON.parse(fs.readFileSync(backendPackagePath, "utf8")).version,
  frontend: JSON.parse(fs.readFileSync(frontendPackagePath, "utf8")).version,
  tauri: tauriConfig.version,
};
const hook = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : "";
const forbiddenPatterns = [
  /froozerp-local\.sqlite3/i,
  /Remove-Item/i,
  /RMDir\s+["']?\$APPDATA/i,
  /Delete\s+["']?\$APPDATA/i,
  /com\.srtcompany\.froozerp.*RMDir/i,
  /com\.srtcompany\.froozerp.*Delete/i,
];

const failures = [];
const warnings = [];
if (tauriConfig.identifier !== "com.srtcompany.froozerp") {
  failures.push(`Unexpected app identifier: ${tauriConfig.identifier}`);
}
if (!tauriConfig.bundle?.createUpdaterArtifacts) {
  failures.push("Tauri updater artifacts are not enabled.");
}
// The local build flavour must stay local.
//
// `src-tauri/tauri.unsigned.conf.json5` exists so the maintainer can build an installer for the
// shop's own machine without the release signing key. It does that by turning updater artifacts
// off — which is exactly what the check above forbids for a release. If the release workflow ever
// picked up that overlay, every published release would silently stop carrying an update, and the
// check above would keep passing because it reads the main config.
//
// So the two are kept apart here, by name: the workflow runs `build:windows`, the maintainer runs
// `build:windows:local`, and neither may quietly become the other. Also pinned: the overlay changes
// nothing but that one flag, so "the local build differs from the release build" can never become a
// real difference in what is installed.
if (fs.existsSync(unsignedOverlayPath)) {
  const overlay = fs.readFileSync(unsignedOverlayPath, "utf8");
  const overlayKeys = overlay.replace(/^\s*\/\/.*$/gm, "").match(/^\s*"?([A-Za-z_$][\w$]*)"?\s*:/gm) || [];
  const named = overlayKeys.map((line) => line.trim().replace(/[":]/g, ""));
  const permitted = new Set(["bundle", "createUpdaterArtifacts"]);
  const unexpected = named.filter((key) => !permitted.has(key));
  if (unexpected.length) {
    failures.push(`Unsigned build overlay changes more than updater artifacts: ${unexpected.join(", ")}`);
  }

  if (releaseWorkflow.includes("build:windows:local")) {
    failures.push("The release workflow runs the unsigned local build; published releases would carry no update.");
  }
  if (!releaseWorkflow.includes("npm run build:windows\n")) {
    failures.push("The release workflow no longer runs `npm run build:windows`.");
  }
  if (!rootPackage.scripts?.["build:windows:local"]?.includes("tauri.unsigned.conf.json5")) {
    failures.push("`build:windows:local` must build through the unsigned overlay.");
  }
  if (rootPackage.scripts?.["build:windows"]?.includes("tauri.unsigned.conf.json5")) {
    failures.push("`build:windows` must not use the unsigned overlay; it is the release build.");
  }
}

if (new Set(Object.values(releaseVersions)).size !== 1) {
  failures.push(`Release versions are inconsistent: ${JSON.stringify(releaseVersions)}`);
}
if (tauriConfig.plugins?.updater?.windows?.installMode !== "quiet") {
  failures.push("Windows in-app updater installMode must be quiet so no external installer window is left open.");
}
if (!tauriConfig.plugins?.updater?.pubkey || /REPLACE_WITH/i.test(tauriConfig.plugins.updater.pubkey)) {
  const message = "Tauri updater public key is not configured.";
  if (process.env.CI === "true" || process.env.FROOZERP_REQUIRE_UPDATER_KEY === "1") {
    failures.push(message);
  } else {
    warnings.push(message);
  }
}
for (const pattern of forbiddenPatterns) {
  if (pattern.test(hook)) {
    failures.push(`Installer hook contains unsafe app-data deletion pattern: ${pattern}`);
  }
}
if (path.resolve(appDataDir).toLowerCase().startsWith(path.resolve(installDir).toLowerCase())) {
  failures.push(`App data directory is inside install directory: ${appDataDir}`);
}

if (failures.length) {
  console.error("Update safety verification failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(JSON.stringify({
  ok: true,
  identifier: tauriConfig.identifier,
  version: tauriConfig.version,
  releaseVersions,
  installDir,
  appDataDir,
  preservedData: [
    "SQLite database",
    "device identity",
    "offline sync queue",
    "user settings",
    "printer settings",
    "weighing-scale settings",
    "branch configuration",
    "backup configuration",
  ],
  warnings,
}, null, 2));
